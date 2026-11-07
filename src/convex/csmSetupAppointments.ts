import { ConvexError, v, type Infer } from 'convex/values';
import { RateLimiter } from '@convex-dev/rate-limiter';
import { components, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
	query,
	type ActionCtx,
	type MutationCtx,
	type QueryCtx
} from './_generated/server';
import { companyDeletion, liveProfile, requireMembership } from './auth';
import { activeJob, cancelJob } from './emailDeliveries';
import {
	attemptReference,
	calRead,
	calRequest,
	CalRateLimitError,
	object,
	parseCompanyReference,
	parseSetupBooking,
	validBookingUid,
	EVENT_ID,
	type ProviderBooking
} from './csmCal';
import { providerBooking } from './csmBookingValidators';
import { replacementAware } from './csmReplacements';
import {
	needsSupersededSetupRetirement,
	retirePendingSetupJobs,
	retireSupersededSetupAppointment,
	type SetupFiring
} from './csmSetupLifecycle';
import { setupNotice, setupSyncIssue } from './csmSetupValidators';
import schema from './schema';
import {
	pendingSuccessors,
	proveSetupChain,
	coversSetupProof,
	SetupChainError,
	SetupDeferredError
} from './csmSetupChain';

type Appointment = Doc<'csmSetupAppointments'>;
function selectionFor(
	a: Pick<Appointment, 'superseded' | 'status' | 'end'>,
	now: number
): Appointment['selection'] {
	if (a.superseded) return 'superseded';
	return a.status !== 'cancelled' && Date.parse(a.end) <= now
		? 'hidden'
		: a.status === 'cancelled'
			? 'cancelled'
			: a.status === 'accepted'
				? 'scheduled'
				: 'checking';
}
const rowArgs = { id: v.id('csmSetupAppointments') };
const memberArgs = { membershipId: v.id('memberships') };
const ACTIVE_INTERVAL = 15 * 60_000;
const CANCELLED_INTERVAL = 24 * 60 * 60_000;
const LEASE_TIME = 3 * 60_000; // Nine bounded reads fit inside this lease.
const limiter = new RateLimiter(components.rateLimiter, {
	setupRevisit: { kind: 'token bucket', rate: 1, period: 60_000, capacity: 1 }
});
async function ownerState(ctx: QueryCtx, a: Pick<Appointment, 'companyId' | 'profileId'>) {
	const [company, profile, deletion] = await Promise.all([
		ctx.db.get('company', a.companyId),
		liveProfile(ctx, a.profileId),
		companyDeletion(ctx, a.companyId)
	]);
	if (!company || !profile || deletion?.status === 'cleaning' || deletion?.status === 'complete')
		return 'erased';
	return deletion ? 'paused' : 'active';
}
async function authorize(ctx: QueryCtx, membershipId: Id<'memberships'>) {
	const owner = await requireMembership(ctx, membershipId);
	if (owner.membership.role !== 'admin') throw new ConvexError('Administrator access is required.');
	return owner;
}
export async function cancelAppointmentJobs(ctx: MutationCtx, a: Appointment) {
	await cancelJob(ctx, a.refreshJobId);
	await cancelJob(ctx, a.deadlineJobId);
}
async function remove(ctx: MutationCtx, a: Appointment, firing?: SetupFiring) {
	await retirePendingSetupJobs(ctx, a, firing);
	await ctx.db.delete('csmSetupAppointments', a._id);
}
async function pause(ctx: MutationCtx, a: Appointment, hint?: string, firing?: SetupFiring) {
	if (a.superseded) {
		await retireSupersededSetupAppointment(ctx, a, hint, firing);
		return;
	}
	await retirePendingSetupJobs(ctx, a, firing);
	await ctx.db.patch('csmSetupAppointments', a._id, {
		pendingSuccessors: pendingSuccessors(a, hint),
		successorHint: undefined,
		generation: a.generation + 1,
		dirty: true,
		freshUntil: undefined,
		leaseUntil: undefined,
		refreshJobId: undefined,
		deadlineJobId: undefined,
		repairAt: Date.now() + 60_000,
		selection: selectionFor(a, Date.now())
	});
}
/** Bounded identity lookup, including one-sided legacy chains. Nonunique locators fail closed. */
async function represented(ctx: QueryCtx, uids: string[]): Promise<Appointment[] | null> {
	if (uids.length > 9 || uids.some((uid) => !validBookingUid(uid))) return null;
	const rows = new Map<string, Appointment>();
	for (const uid of new Set(uids)) {
		for (const index of ['by_currentUid', 'by_anchorUid'] as const) {
			const matches = await ctx.db
				.query('csmSetupAppointments')
				.withIndex(index, (q) =>
					index === 'by_currentUid' ? q.eq('currentUid', uid) : q.eq('anchorUid', uid)
				)
				.take(2);
			if (matches.length > 1) return null;
			for (const row of matches) rows.set(row._id, row);
		}
	}
	return [...rows.values()];
}
async function byUid(ctx: QueryCtx, uid: string) {
	const rows = await represented(ctx, [uid]);
	return rows?.length === 1 ? rows[0] : null;
}
async function enqueue(ctx: MutationCtx, a: Appointment, successorHint?: string) {
	const ownership = await ownerState(ctx, a);
	if (ownership === 'erased') {
		await remove(ctx, a);
		return;
	}
	if (a.superseded) {
		await retireSupersededSetupAppointment(ctx, a, successorHint);
		return;
	}
	if (ownership === 'paused') {
		await pause(ctx, a, successorHint);
		return;
	}
	const now = Date.now();
	const jobRunning = await activeJob(ctx, a.refreshJobId);
	const refreshJobId = jobRunning
		? a.refreshJobId
		: await ctx.scheduler.runAfter(0, internal.csmSetupAppointments.refresh, { id: a._id });
	await ctx.db.patch('csmSetupAppointments', a._id, {
		generation: a.generation + 1,
		dirty: true,
		refreshJobId,
		leaseUntil: a.leaseUntil,
		repairAt: a.leaseUntil && a.leaseUntil > now ? a.leaseUntil : now,
		pendingSuccessors: pendingSuccessors(a, successorHint),
		successorHint: undefined
	});
}
async function scheduleDeadline(ctx: MutationCtx, a: Appointment) {
	if (a.superseded) {
		await retireSupersededSetupAppointment(ctx, a);
		return;
	}
	// Never cancel an already firing expiry.
	if (a.deadlineJobId) {
		const job = await ctx.db.system.get('_scheduled_functions', a.deadlineJobId);
		if (job?.state.kind === 'pending') await ctx.scheduler.cancel(a.deadlineJobId);
	}
	const now = Date.now(),
		end = Date.parse(a.end);
	const deadline =
		a.status === 'cancelled' || end <= now
			? undefined
			: Math.min(end, a.freshUntil && a.freshUntil > now ? a.freshUntil : end);
	const deadlineJobId =
		deadline === undefined
			? undefined
			: await ctx.scheduler.runAt(deadline, internal.csmSetupAppointments.expire, {
					id: a._id,
					end: a.end,
					freshUntil: a.freshUntil ?? null
				});
	await ctx.db.patch('csmSetupAppointments', a._id, { deadlineJobId });
}
type Source = Pick<
	Appointment,
	'companyId' | 'profileId' | 'source' | 'anchorUid' | 'membershipId' | 'attemptId'
>;
/** Both admission paths share defaults and job order after their distinct trust checks. */
async function initializeAppointment(
	ctx: MutationCtx,
	source: Source,
	b: Pick<ProviderBooking, 'uid' | 'start' | 'end'>,
	hint?: string
) {
	const id = await ctx.db.insert('csmSetupAppointments', {
		...source,
		currentUid: b.uid,
		start: b.start,
		end: b.end,
		status: 'checking',
		selection: Date.parse(b.end) > Date.now() ? 'checking' : 'hidden',
		sortAt: Date.parse(b.start),
		generation: 0,
		lease: 0,
		dirty: true,
		failures: 0,
		pendingSuccessors: { uids: [], overflow: false }
	});
	const row = (await ctx.db.get('csmSetupAppointments', id))!;
	await enqueue(ctx, row, hint);
	await scheduleDeadline(ctx, row);
	return true;
}
/** Creation confirmation and current appointment state have separate lifetimes. */
export async function seedSetupAppointment(ctx: MutationCtx, a: Doc<'csmBookingAttempts'>) {
	if (a.mode !== 'setup' || !a.confirmation || (await ownerState(ctx, a)) !== 'active')
		return false;
	// Settlement, initialization and receipt maintenance all preserve the same permanent latch.
	if (a.replacement) {
		const source = await ctx.db.get('csmSetupAppointments', a.replacement.appointmentId);
		if (source?.companyId === a.companyId && source.replacementAttemptId === a._id)
			await retireSupersededSetupAppointment(ctx, source);
	}
	if (
		await ctx.db
			.query('csmSetupAppointments')
			.withIndex('by_attemptId', (q) => q.eq('attemptId', a._id))
			.unique()
	)
		return false;
	const existing = await represented(ctx, [a.confirmation.uid]);
	if (!existing || existing.length) return false;
	return initializeAppointment(
		ctx,
		{
			companyId: a.companyId,
			profileId: a.profileId,
			membershipId: a.membershipId,
			attemptId: a._id,
			source: 'native',
			anchorUid: a.confirmation.uid
		},
		a.confirmation
	);
}
async function candidate(ctx: QueryCtx, companyId: Id<'company'>): Promise<Appointment | null> {
	for (const selection of ['scheduled', 'cancelled', 'checking'] as const) {
		const rows = ctx.db
			.query('csmSetupAppointments')
			.withIndex('by_companyId_and_selection_and_sortAt_and_anchorUid', (q) =>
				q.eq('companyId', companyId).eq('selection', selection)
			)
			.order(selection === 'cancelled' ? 'desc' : 'asc');
		let examined = 0;
		for await (const row of rows) {
			if (!row.superseded && (await ownerState(ctx, row)) === 'active') return row;
			if (++examined === 4) break;
		}
	}
	return null;
}
export const current = query({
	args: memberArgs,
	returns: setupNotice,
	handler: async (ctx, { membershipId }): Promise<Infer<typeof setupNotice>> => {
		const { companyId } = await authorize(ctx, membershipId);
		const a = await candidate(ctx, companyId);
		if (!a) return null;
		return {
			id: a._id,
			currentUid: a.currentUid,
			state:
				a.selection === 'cancelled'
					? 'cancelled'
					: a.selection === 'scheduled' && !a.dirty
						? 'scheduled'
						: 'checking',
			start: a.start,
			end: a.end,
			freshUntil: a.freshUntil ?? null
		};
	}
});
async function advanceExpired(ctx: MutationCtx, companyId: Id<'company'>) {
	let more = false;
	for (const selection of ['scheduled', 'checking'] as const) {
		const rows = await ctx.db
			.query('csmSetupAppointments')
			.withIndex('by_companyId_and_selection_and_sortAt_and_anchorUid', (q) =>
				q.eq('companyId', companyId).eq('selection', selection)
			)
			.take(8);
		let advanced = 0;
		for (const a of rows) {
			const ownership = await ownerState(ctx, a);
			if (ownership === 'erased') {
				await remove(ctx, a);
				advanced++;
			} else if (a.superseded) {
				if (await retireSupersededSetupAppointment(ctx, a)) advanced++;
			} else if (ownership === 'paused') {
				await pause(ctx, a);
			} else if (Date.parse(a.end) <= Date.now()) {
				await ctx.db.patch('csmSetupAppointments', a._id, { selection: 'hidden' });
				await enqueue(ctx, a);
				advanced++;
			}
		}
		more ||= advanced === 8;
	}
	if (more) await ctx.scheduler.runAfter(0, internal.csmSetupAppointments.advance, { companyId });
}
export const advance = internalMutation({
	args: { companyId: v.id('company') },
	returns: v.null(),
	handler: async (ctx, { companyId }) => {
		await advanceExpired(ctx, companyId);
		return null;
	}
});
/** Revisit/sleep repair is shared across all admins/tabs and performs no provider IO here. */
export const revisit = mutation({
	args: memberArgs,
	returns: v.null(),
	handler: async (ctx, { membershipId }) => {
		const { companyId } = await authorize(ctx, membershipId);
		if (!(await limiter.limit(ctx, 'setupRevisit', { key: companyId })).ok) return null;
		await advanceExpired(ctx, companyId);
		const a = await candidate(ctx, companyId);
		if (a) await enqueue(ctx, a);
		// Ordinary hidden chains can recover a later missed post-end provider reschedule.
		const hidden = await ctx.db
			.query('csmSetupAppointments')
			.withIndex('by_companyId_and_selection_and_sortAt_and_anchorUid', (q) =>
				q.eq('companyId', companyId).eq('selection', 'hidden')
			)
			.order('desc')
			.first();
		if (hidden) await enqueue(ctx, hidden);
		return null;
	}
});
/** HMAC-verified webhooks invalidate facts; only an authenticated provider read replaces them. */
export const notify = internalMutation({
	args: {
		uid: v.string(),
		attemptId: v.optional(v.id('csmBookingAttempts')),
		companyReference: v.optional(v.string()),
		previousUid: v.optional(v.string()),
		successorHint: v.optional(v.string())
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		if (
			!validBookingUid(args.uid) ||
			(args.successorHint !== undefined && !validBookingUid(args.successorHint))
		)
			return false;
		const companyId =
			args.companyReference !== undefined
				? ctx.db.normalizeId('company', args.companyReference)
				: undefined;
		if (args.companyReference !== undefined && !companyId) return false;
		let a: Appointment | null = null;
		if (args.attemptId) {
			const attempt = await ctx.db.get('csmBookingAttempts', args.attemptId);
			if (
				!attempt ||
				attempt.mode !== 'setup' ||
				!attempt.confirmation ||
				(companyId && attempt.companyId !== companyId)
			)
				return false;
			await seedSetupAppointment(ctx, attempt);
			a = await ctx.db
				.query('csmSetupAppointments')
				.withIndex('by_attemptId', (q) => q.eq('attemptId', args.attemptId))
				.unique();
		} else
			a =
				(await byUid(ctx, args.uid)) ??
				(args.previousUid && validBookingUid(args.previousUid)
					? await byUid(ctx, args.previousUid)
					: null);
		if (!a || (companyId && a.companyId !== companyId)) return false;
		const ownership = await ownerState(ctx, a);
		if (ownership === 'erased') {
			await remove(ctx, a);
			return false;
		}
		await enqueue(ctx, a, args.successorHint);
		return true;
	}
});
export const claimResult = v.union(
	v.null(),
	v.object({
		appointment: schema.doc('csmSetupAppointments'),
		reference: v.optional(v.string())
	})
);
export async function claimSetupAppointment(
	ctx: MutationCtx,
	id: Id<'csmSetupAppointments'>,
	expiresAt?: number
): Promise<Infer<typeof claimResult>> {
	const a = await ctx.db.get('csmSetupAppointments', id);
	if (!a) return null;
	const ownership = await ownerState(ctx, a);
	if (ownership === 'erased') {
		await remove(ctx, a, 'refresh');
		return null;
	}
	if (a.superseded) {
		await retireSupersededSetupAppointment(ctx, a, undefined, 'refresh');
		return null;
	}
	if (ownership === 'paused') {
		await pause(ctx, a, undefined, 'refresh');
		return null;
	}
	if (a.leaseUntil && a.leaseUntil > Date.now()) return null;
	const leaseUntil = Math.min(Date.now() + LEASE_TIME, expiresAt ?? Infinity);
	if (leaseUntil <= Date.now()) return null;
	const pending = pendingSuccessors(a);
	await ctx.db.patch('csmSetupAppointments', id, {
		lease: a.lease + 1,
		leaseUntil,
		repairAt: leaseUntil,
		pendingSuccessors: pending,
		successorHint: undefined
	});
	const attempt = a.attemptId ? await ctx.db.get('csmBookingAttempts', a.attemptId) : null;
	return {
		appointment: {
			...a,
			lease: a.lease + 1,
			leaseUntil,
			pendingSuccessors: pending,
			successorHint: undefined
		},
		...(attempt ? { reference: attemptReference(attempt) } : {})
	};
}
export const claim = internalMutation({
	args: rowArgs,
	returns: claimResult,
	handler: (ctx, { id }) => claimSetupAppointment(ctx, id)
});
export const refreshResult = v.union(
	v.object({
		kind: v.literal('success'),
		booking: providerBooking,
		proofUids: v.array(v.string())
	}),
	v.object({ kind: v.literal('failure'), issue: setupSyncIssue }),
	v.object({ kind: v.literal('deferred'), retryAt: v.number() })
);
function compatibleLegacy(
	a: Appointment,
	b: Pick<Appointment, 'source' | 'companyId' | 'profileId' | 'attemptId'>
) {
	return (
		a.source === 'legacy' &&
		b.source === 'legacy' &&
		!a.attemptId &&
		!b.attemptId &&
		!replacementAware(a) &&
		a.companyId === b.companyId &&
		a.profileId === b.profileId
	);
}
function oldest(rows: Appointment[]) {
	return rows.sort(
		(a, b) => a._creationTime - b._creationTime || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0)
	)[0];
}
function conflictingFacts(a: Appointment, b: ProviderBooking) {
	if (b.uid !== a.currentUid || a.providerUpdatedAt === undefined) return false;
	const status =
		b.status === 'accepted' ? 'accepted' : b.status === 'pending' ? 'checking' : 'cancelled';
	return (
		b.updatedAt < a.providerUpdatedAt ||
		(b.updatedAt === a.providerUpdatedAt &&
			(b.start !== a.start || b.end !== a.end || status !== a.status))
	);
}
export const setupProof = v.object({
	...rowArgs,
	generation: v.number(),
	lease: v.number(),
	currentUid: v.string(),
	result: refreshResult
});
export async function applySetupProof(
	ctx: MutationCtx,
	args: Infer<typeof setupProof>
): Promise<null> {
	const a = await ctx.db.get('csmSetupAppointments', args.id);
	if (!a) return null;
	if (!a.superseded && (a.lease !== args.lease || a.currentUid !== args.currentUid)) return null;
	const ownership = await ownerState(ctx, a);
	if (ownership === 'erased') {
		await remove(ctx, a, 'refresh');
		return null;
	}
	if (a.superseded) {
		await retireSupersededSetupAppointment(ctx, a, undefined, 'refresh');
		return null;
	}
	if (ownership === 'paused') {
		await pause(ctx, a, undefined, 'refresh');
		return null;
	}
	if (a.generation !== args.generation) {
		await enqueue(ctx, { ...a, leaseUntil: undefined, refreshJobId: undefined });
		return null;
	}
	const now = Date.now(),
		pending = pendingSuccessors(a);
	// No expired claim can publish facts, even if ordinary repair has not run yet.
	let b =
		args.result.kind === 'success' &&
		a.leaseUntil !== undefined &&
		a.leaseUntil > now &&
		coversSetupProof(args.result.proofUids, [a.currentUid, args.result.booking.uid], pending)
			? args.result.booking
			: undefined;
	let issue: Infer<typeof setupSyncIssue> =
		args.result.kind === 'failure' ? args.result.issue : pending.overflow ? 'cap' : 'chain';
	if (b && conflictingFacts(a, b)) {
		b = undefined;
		issue = 'conflict';
	}
	if (b && args.result.kind === 'success') {
		const representedRows = await represented(ctx, args.result.proofUids);
		const others = representedRows?.filter((row) => row._id !== a._id);
		if (!representedRows || !others) {
			b = undefined;
			issue = 'conflict';
		} else if (others.length) {
			const affected = [a, ...others];
			const compatible = affected.every(
				(row) =>
					compatibleLegacy(row, a) &&
					!conflictingFacts(row, b!) &&
					coversSetupProof(
						args.result.kind === 'success' ? args.result.proofUids : [],
						[row.currentUid],
						pendingSuccessors(row)
					)
			);
			if (!compatible) {
				b = undefined;
				issue = 'conflict';
			} else {
				const survivor = oldest(affected);
				for (const loser of affected) {
					if (loser._id !== survivor._id)
						await remove(ctx, loser, loser._id === a._id ? 'refresh' : undefined);
				}
				if (survivor._id !== a._id) {
					// A loser claim cannot publish for, or discharge obligations of, the survivor.
					await enqueue(ctx, survivor);
					await scheduleDeadline(ctx, survivor);
					return null;
				}
			}
		}
	}
	if (!b) {
		const deferred = args.result.kind === 'deferred' && Number.isFinite(args.result.retryAt);
		const failures = deferred ? a.failures : Math.min(a.failures + 1, 12);
		await ctx.db.patch('csmSetupAppointments', a._id, {
			leaseUntil: undefined,
			refreshJobId: undefined,
			dirty: true,
			failures,
			pendingSuccessors: pending,
			successorHint: undefined,
			issue: deferred ? a.issue : issue,
			repairAt:
				deferred && args.result.kind === 'deferred'
					? Math.max(now + 1, args.result.retryAt)
					: now + Math.min(ACTIVE_INTERVAL, 30_000 * 2 ** failures) + Math.random() * 10_000,
			selection: selectionFor(a, now)
		});
		return null;
	}
	const status =
		b.status === 'accepted' ? 'accepted' : b.status === 'pending' ? 'checking' : 'cancelled';
	const ended = Date.parse(b.end) <= now;
	const selection = selectionFor({ ...a, status, end: b.end }, now);
	const freshUntil = status === 'accepted' ? now + ACTIVE_INTERVAL : undefined;
	await ctx.db.patch('csmSetupAppointments', a._id, {
		currentUid: b.uid,
		start: b.start,
		end: b.end,
		status,
		selection,
		sortAt: status === 'cancelled' ? b.updatedAt : Date.parse(b.start),
		providerUpdatedAt: b.updatedAt,
		observedAt: now,
		freshUntil,
		leaseUntil: undefined,
		refreshJobId: undefined,
		dirty: false,
		failures: 0,
		issue: undefined,
		pendingSuccessors: { uids: [], overflow: false },
		successorHint: undefined,
		repairAt:
			status === 'cancelled'
				? now + CANCELLED_INTERVAL
				: status === 'accepted' && ended
					? undefined
					: Math.min(now + ACTIVE_INTERVAL, ended ? now + ACTIVE_INTERVAL : Date.parse(b.end))
	});
	await scheduleDeadline(ctx, (await ctx.db.get('csmSetupAppointments', a._id))!);
	return null;
}
export const commit = internalMutation({
	args: setupProof.fields,
	returns: v.null(),
	handler: applySetupProof
});
/** Refresh has a long lease; a creation sender supplies its shorter queued deadline. */
export async function readSetupProof(
	ctx: ActionCtx,
	snapshot: NonNullable<Infer<typeof claimResult>>,
	deadline: number,
	waitForQuota = false
) {
	const a = snapshot.appointment;
	return proveSetupChain(a.currentUid, pendingSuccessors(a), async (uid) => {
		while (true) {
			// Already claimed reads may continue through a reversible pause. Ownership
			// is rechecked transactionally at commit, without a query before every GET.
			if (Date.now() + 12_000 > deadline) throw new SetupDeferredError(Date.now() + 60_000);
			let raw: unknown;
			try {
				raw = await calRead(ctx, `bookings/${encodeURIComponent(uid)}`, '2026-02-25');
			} catch (error) {
				if (!(error instanceof CalRateLimitError) || !waitForQuota) throw error;
				const delay = Math.ceil(error.retryAfter) + 10;
				if (Date.now() + delay + 12_000 > deadline)
					throw new SetupDeferredError(Date.now() + Math.ceil(error.retryAfter));
				await new Promise((resolve) => setTimeout(resolve, delay));
				continue;
			}
			const booking = parseSetupBooking(raw, uid, {
				companyId: a.companyId,
				profileId: a.profileId,
				attemptReference: snapshot.reference
			});
			if (!booking) throw new SetupChainError('chain');
			return booking;
		}
	});
}
export const refresh = internalAction({
	args: rowArgs,
	returns: v.null(),
	handler: async (ctx, { id }) => {
		const snapshot: Infer<typeof claimResult> = await ctx.runMutation(
			internal.csmSetupAppointments.claim,
			{ id }
		);
		if (!snapshot) return null;
		const a = snapshot.appointment;
		const result = await readSetupProof(ctx, snapshot, a.leaseUntil! - 15_000, true);
		await ctx.runMutation(internal.csmSetupAppointments.commit, {
			id,
			generation: a.generation,
			lease: a.lease,
			currentUid: a.currentUid,
			result:
				result.kind === 'success'
					? { kind: 'success', booking: result.booking, proofUids: result.proofUids }
					: result
		});
		return null;
	}
});
/** Presentation expiry never waits for provider IO, provider budget, or a refresh lease. */
export const expire = internalMutation({
	args: { ...rowArgs, end: v.string(), freshUntil: v.union(v.number(), v.null()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const a = await ctx.db.get('csmSetupAppointments', args.id);
		if (!a) return null;
		if (!a.superseded && (a.end !== args.end || (a.freshUntil ?? null) !== args.freshUntil))
			return null;
		const ownership = await ownerState(ctx, a);
		if (ownership === 'erased') {
			await remove(ctx, a, 'deadline');
			return null;
		}
		if (a.superseded) {
			await retireSupersededSetupAppointment(ctx, a, undefined, 'deadline');
			return null;
		}
		if (ownership === 'paused') {
			await pause(ctx, a, undefined, 'deadline');
			return null;
		}
		if (a.status === 'cancelled') {
			await ctx.db.patch('csmSetupAppointments', a._id, { deadlineJobId: undefined });
			return null;
		}
		if (Date.parse(a.end) <= Date.now())
			await ctx.db.patch('csmSetupAppointments', a._id, { selection: 'hidden' });
		await enqueue(ctx, a);
		// This mutation owns the firing deadline; cancelling itself could roll it back.
		await scheduleDeadline(ctx, { ...a, deadlineJobId: undefined });
		return null;
	}
});
export const repairDue = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const rows = await ctx.db
			.query('csmSetupAppointments')
			.withIndex('by_repairAt', (q) => q.gt('repairAt', 0).lte('repairAt', Date.now()))
			.take(5);
		for (const a of rows) {
			const ownership = await ownerState(ctx, a);
			if (ownership === 'erased') await remove(ctx, a);
			else if (a.superseded) await retireSupersededSetupAppointment(ctx, a);
			else if (ownership === 'paused') await pause(ctx, a);
			else {
				// Recover abandoned actions, including leases whose scheduled job was retained as active.
				if (a.leaseUntil && a.leaseUntil <= Date.now()) {
					await retirePendingSetupJobs(ctx, { ...a, deadlineJobId: undefined });
					await enqueue(ctx, { ...a, leaseUntil: undefined, refreshJobId: undefined });
				} else await enqueue(ctx, a);
			}
		}
		return null;
	}
});
/** Explicit, resumable maintenance; private receipt survival is irrelevant to retirement. */
export const normalizeSuperseded = internalMutation({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: v.object({
		cursor: v.string(),
		isDone: v.boolean(),
		scanned: v.number(),
		normalized: v.number()
	}),
	handler: async (ctx, { cursor }) => {
		const page = await ctx.db
			.query('csmSetupAppointments')
			.withIndex('by_creation_time')
			.paginate({ cursor, numItems: 25 });
		let normalized = 0;
		for (const a of page.page) {
			if (!a.superseded) continue;
			if ((await ownerState(ctx, a)) === 'erased') await remove(ctx, a);
			else if (await retireSupersededSetupAppointment(ctx, a)) normalized++;
		}
		return {
			cursor: page.continueCursor,
			isDone: page.isDone,
			scanned: page.page.length,
			normalized
		};
	}
});
/** Page-local completion evidence only; no identities, receipts or provider locators. */
export const normalizationInventory = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: v.object({
		cursor: v.string(),
		isDone: v.boolean(),
		scanned: v.number(),
		superseded: v.number(),
		remaining: v.number()
	}),
	handler: async (ctx, { cursor }) => {
		const page = await ctx.db
			.query('csmSetupAppointments')
			.withIndex('by_creation_time')
			.paginate({ cursor, numItems: 25 });
		return {
			cursor: page.continueCursor,
			isDone: page.isDone,
			scanned: page.page.length,
			superseded: page.page.filter((a) => a.superseded).length,
			remaining: page.page.filter(needsSupersededSetupRetirement).length
		};
	}
});
/** Explicit initialization only; maintainReceipts normalizes first and also uses the shared seed. */
export const initialize = internalMutation({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: v.object({
		cursor: v.string(),
		isDone: v.boolean(),
		scanned: v.number(),
		seeded: v.number(),
		blocked: v.number()
	}),
	handler: async (ctx, { cursor }) => {
		const page = await ctx.db
			.query('csmBookingAttempts')
			.withIndex('by_creation_time')
			.paginate({ cursor, numItems: 25 });
		let seeded = 0,
			blocked = 0;
		for (const a of page.page) {
			if (a.mode === 'setup' && a.state === 'booked' && !a.confirmation) blocked++;
			if (await seedSetupAppointment(ctx, a)) seeded++;
		}
		return {
			cursor: page.continueCursor,
			isDone: page.isDone,
			scanned: page.page.length,
			seeded,
			blocked
		};
	}
});

export const seedLegacy = internalMutation({
	args: {
		companyReference: v.string(),
		profileReference: v.string(),
		anchor: providerBooking,
		booking: providerBooking,
		admittedUid: v.string(),
		proofUids: v.array(v.string()),
		successorHint: v.optional(v.string())
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		if (args.successorHint !== undefined && !validBookingUid(args.successorHint)) return false;
		if (
			!coversSetupProof(args.proofUids, [args.anchor.uid, args.admittedUid, args.booking.uid], {
				uids: [],
				overflow: false
			})
		)
			return false;
		const companyId = ctx.db.normalizeId('company', args.companyReference);
		const profileId = ctx.db.normalizeId('profiles', args.profileReference);
		if (!companyId || !profileId || (await ownerState(ctx, { companyId, profileId })) !== 'active')
			return false;
		const existing = await represented(ctx, args.proofUids);
		if (!existing) return false;
		if (existing.length) {
			if (
				existing.every((row) => compatibleLegacy(row, { companyId, profileId, source: 'legacy' }))
			) {
				const survivor = oldest(existing);
				await enqueue(ctx, survivor, args.booking.uid);
				if (args.successorHint !== undefined) {
					const updated = (await ctx.db.get('csmSetupAppointments', survivor._id))!;
					await enqueue(ctx, updated, args.successorHint);
				}
			}
			return false;
		}
		return initializeAppointment(
			ctx,
			{
				companyId,
				profileId,
				source: 'legacy',
				anchorUid: args.anchor.uid
			},
			args.booking,
			args.successorHint
		);
	}
});
/** Source-unbound history needs explicit reviewed original-source evidence, never an email match. */
async function adoptLegacy(
	ctx: ActionCtx,
	uid: string,
	reviewedProfileId?: Id<'profiles'>,
	sourceEvidence?: string,
	successorHint?: string
) {
	if (!validBookingUid(uid) || (successorHint !== undefined && !validBookingUid(successorHint)))
		return false;
	const raw = await calRead(ctx, `bookings/${encodeURIComponent(uid)}`, '2026-02-25');
	if (
		!object(raw) ||
		!object(raw.metadata) ||
		raw.metadata.dinuCsmAttempt !== undefined ||
		typeof raw.metadata.dinuCsmReference !== 'string'
	)
		return false;
	const reference = await parseCompanyReference(raw.metadata.dinuCsmReference);
	if (!reference || reference.mode !== 'setup') return false;
	const profileId =
		reference.profileId ??
		(sourceEvidence?.trim() && sourceEvidence.length <= 2000 ? reviewedProfileId : undefined);
	if (
		!profileId ||
		(reference.profileId && reviewedProfileId && reference.profileId !== reviewedProfileId)
	)
		return false;
	const scope = { companyId: reference.companyId, profileId };
	const initial = parseSetupBooking(raw, uid, scope);
	if (!initial) return false;
	// No refresh lease exists here: local quota denial remains an immediate failure.
	const result = await proveSetupChain(
		uid,
		{ uids: [], overflow: false },
		async (linkedUid) => {
			const booking = parseSetupBooking(
				await calRead(ctx, `bookings/${encodeURIComponent(linkedUid)}`, '2026-02-25'),
				linkedUid,
				scope
			);
			if (!booking) throw new SetupChainError('chain');
			return booking;
		},
		{ includeAncestors: true, initial }
	);
	if (result.kind !== 'success') return false;
	return ctx.runMutation(internal.csmSetupAppointments.seedLegacy, {
		companyReference: reference.companyId,
		profileReference: profileId,
		anchor: result.anchor,
		booking: result.booking,
		admittedUid: uid,
		proofUids: result.proofUids,
		...(successorHint !== undefined ? { successorHint } : {})
	});
}
export const importLegacy = internalAction({
	args: {
		uid: v.string(),
		reviewedProfileId: v.optional(v.id('profiles')),
		sourceEvidence: v.optional(v.string())
	},
	returns: v.boolean(),
	handler: (ctx, a): Promise<boolean> =>
		adoptLegacy(ctx, a.uid, a.reviewedProfileId, a.sourceEvidence)
});
export const legacyWebhook = internalAction({
	args: {
		reference: v.string(),
		uid: v.string(),
		previousUid: v.optional(v.string()),
		successorHint: v.optional(v.string())
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		if (
			!validBookingUid(args.uid) ||
			(args.successorHint !== undefined && !validBookingUid(args.successorHint))
		)
			return null;
		const reference = await parseCompanyReference(args.reference);
		if (!reference || reference.mode !== 'setup') return null;
		// Normalize the signed company inside a mutation; malformed/erased IDs cannot bind a row.
		const known: boolean = await ctx.runMutation(internal.csmSetupAppointments.notify, {
			uid: args.uid,
			previousUid: args.previousUid,
			successorHint: args.successorHint,
			companyReference: reference.companyId
		});
		if (known) return null;
		if (reference.profileId)
			await adoptLegacy(ctx, args.uid, undefined, undefined, args.successorHint);
		else {
			// A source-unbound delivery may still belong to an already reviewed chain.
			// Explicit authenticated links can locate it without inferring a booker.
			const queue = new Set([args.uid]);
			for (const uid of queue) {
				const raw = await calRead(ctx, `bookings/${encodeURIComponent(uid)}`, '2026-02-25');
				const b = parseSetupBooking(raw, uid);
				if (!b || !object(raw)) break;
				const metadata = object(raw.metadata) ? raw.metadata : {};
				if (metadata.dinuCsmAttempt !== undefined) break;
				if (metadata.dinuCsmReference !== undefined) {
					const scope =
						typeof metadata.dinuCsmReference === 'string'
							? await parseCompanyReference(metadata.dinuCsmReference)
							: null;
					if (!scope || scope.companyId !== reference.companyId || scope.mode !== 'setup') break;
				}
				if (
					await ctx.runMutation(internal.csmSetupAppointments.notify, {
						uid,
						companyReference: reference.companyId,
						successorHint: args.successorHint ?? args.uid
					})
				)
					return null;
				for (const neighbor of [b.fromUid, b.toUid]) {
					if (neighbor && !queue.has(neighbor)) {
						if (queue.size >= 9) break;
						queue.add(neighbor);
					}
				}
			}
			console.warn(
				'Setup call notice: source-unbound legacy delivery requires reviewed attribution.'
			);
		}
		return null;
	}
});
/** Omit status to cover past/cancelled/unconfirmed too; one opaque provider page per invocation. */
export const discoverLegacy = internalAction({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: v.object({
		cursor: v.union(v.string(), v.null()),
		isDone: v.boolean(),
		scanned: v.number(),
		eligible: v.number(),
		unattributed: v.number(),
		unresolved: v.number()
	}),
	handler: async (
		ctx,
		args
	): Promise<{
		cursor: string | null;
		isDone: boolean;
		scanned: number;
		eligible: number;
		unattributed: number;
		unresolved: number;
	}> => {
		const params = new URLSearchParams({ eventTypeId: String(EVENT_ID), limit: '100' });
		if (args.cursor) params.set('cursor', args.cursor);
		const response = await calRequest(ctx, `bookings?${params}`, '2026-05-01');
		const body = response.body;
		if (
			!response.ok ||
			!object(body) ||
			body.status !== 'success' ||
			!Array.isArray(body.data) ||
			body.data.length > 100 ||
			!object(body.pagination) ||
			typeof body.pagination.hasMore !== 'boolean' ||
			(body.pagination.hasMore && !validBookingUid(body.pagination.nextCursor))
		)
			throw new Error('Setup appointment inventory is unavailable.');
		let eligible = 0,
			unattributed = 0,
			unresolved = 0;
		for (const raw of body.data) {
			if (
				!object(raw) ||
				!object(raw.metadata) ||
				raw.metadata.dinuCsmAttempt !== undefined ||
				typeof raw.metadata.dinuCsmReference !== 'string'
			)
				continue;
			const reference = await parseCompanyReference(raw.metadata.dinuCsmReference);
			if (!reference || reference.mode !== 'setup') continue;
			eligible++;
			if (!reference.profileId) {
				unattributed++;
				continue;
			}
			if (
				!validBookingUid(raw.uid) ||
				!parseSetupBooking(raw, raw.uid, {
					companyId: reference.companyId,
					profileId: reference.profileId
				})
			) {
				unresolved++;
				continue;
			}
		}
		return {
			cursor: body.pagination.hasMore ? String(body.pagination.nextCursor) : null,
			isDone: !body.pagination.hasMore,
			scanned: body.data.length,
			eligible,
			unattributed,
			unresolved
		};
	}
});

/** Page-local aggregate health, with explicit time; no provider locators or attendee data. */
export const inventory = internalQuery({
	args: { cursor: v.union(v.string(), v.null()), now: v.number() },
	returns: v.object({
		cursor: v.string(),
		isDone: v.boolean(),
		scanned: v.number(),
		verified: v.number(),
		unresolved: v.number(),
		overdue: v.number(),
		capLimited: v.number()
	}),
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query('csmSetupAppointments')
			.withIndex('by_creation_time')
			.paginate({ cursor: args.cursor, numItems: 25 });
		return {
			cursor: page.continueCursor,
			isDone: page.isDone,
			scanned: page.page.length,
			verified: page.page.filter((a) => a.observedAt !== undefined && !a.dirty).length,
			unresolved: page.page.filter((a) => a.dirty || a.status === 'checking').length,
			overdue: page.page.filter((a) => a.repairAt !== undefined && a.repairAt < args.now).length,
			capLimited: page.page.filter((a) => a.issue === 'cap').length
		};
	}
});
