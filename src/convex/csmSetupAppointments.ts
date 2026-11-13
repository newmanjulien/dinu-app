import { ConvexError, v, type Infer } from 'convex/values';
import { RateLimiter } from '@convex-dev/rate-limiter';
import { components, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
	type ActionCtx,
	type MutationCtx,
	type QueryCtx
} from './_generated/server';
import { companyDeletion, liveProfile, requireMembership } from './auth';
import { cancelJob } from './emailDeliveries';
import {
	calRead,
	object,
	parseSetupBooking,
	validBookingUid,
	type ProviderBooking
} from './csmCal';
import { providerBooking, providerScope } from './csmBookingValidators';
import { attemptReference } from './csmHistory';
import { replacementAware } from './csmReplacements';
import {
	clearSetupAppointment,
	readConfirmedSetupBooking,
	resolveSetupBooking,
	transferSetupAppointment
} from './csmSetupState';
import {
	retirePendingSetupJobs,
	retireSupersededSetupAppointment,
	retireReleasedSetupAppointment,
	retireCompanySetupAppointments,
	type SetupFiring
} from './csmSetupLifecycle';
import { setupSyncIssue, setupReviewAttestation } from './csmSetupValidators';
import schema from './schema';
import { ingressResult } from './csmEvidenceValidators';
import { appointmentEvidence, completeAppointmentEvidence } from './csmEvidence';
import { EVIDENCE_PASSES, evidenceRetry } from './csmRecoveryPolicy';
import { validProviderScope } from './csmIdentity';
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
export async function ownerState(ctx: QueryCtx, a: Pick<Appointment, 'companyId' | 'profileId'>) {
	const [company, profile, deletion] = await Promise.all([
		ctx.db.get('company', a.companyId),
		liveProfile(ctx, a.profileId),
		companyDeletion(ctx, a.companyId)
	]);
	if (!company || !profile || deletion?.status === 'cleaning' || deletion?.status === 'complete')
		return 'erased';
	return deletion ? 'paused' : company.templateSourceId ? 'released' : 'active';
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
export async function remove(ctx: MutationCtx, a: Appointment, firing?: SetupFiring) {
	await retirePendingSetupJobs(ctx, a, firing);
	await clearSetupAppointment(ctx, a);
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
export async function represented(ctx: QueryCtx, uids: string[]): Promise<Appointment[] | null> {
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
/** All automatic callers share the same admission, including dirty rows in backoff. */
function refreshAdmission(a: Appointment, mode: 'routine' | 'evidence' | 'forced', now: number) {
	if (a.reviewReason && !(mode === 'evidence' && a.reviewReason === 'evidenceHorizon'))
		return false;
	if (mode !== 'evidence' && a.leaseUntil !== undefined && a.leaseUntil > now) return false;
	if (mode === 'routine' && ((a.freshUntil ?? 0) > now || (a.repairAt ?? 0) > now)) return false;
	return true;
}
export async function retainSetupReview(
	ctx: MutationCtx,
	a: Appointment,
	reason: string,
	firing?: SetupFiring,
	failures = a.failures,
	invalidate = false
) {
	if (
		!invalidate &&
		a.reviewReason === reason &&
		!a.refreshJobId &&
		!a.deadlineJobId &&
		!a.repairAt &&
		!a.leaseUntil &&
		!a.reviewSession
	)
		return;
	await retirePendingSetupJobs(ctx, a, firing);
	await ctx.db.patch('csmSetupAppointments', a._id, {
		reviewReason: reason,
		reviewSession: undefined,
		generation: a.generation + 1,
		dirty: true,
		failures,
		issue:
			reason === 'cap'
				? 'cap'
				: reason === 'conflict'
					? 'conflict'
					: reason === 'chain'
						? 'chain'
						: a.issue,
		pendingSuccessors: pendingSuccessors(a),
		successorHint: undefined,
		refreshJobId: undefined,
		deadlineJobId: undefined,
		repairAt: undefined,
		leaseUntil: undefined,
		freshUntil: undefined
	});
}
export async function enqueue(
	ctx: MutationCtx,
	a: Appointment,
	options: { successorHint?: string; invalidate?: boolean } = {}
) {
	const { successorHint, invalidate = successorHint !== undefined } = options;
	const ownership = await ownerState(ctx, a);
	if (ownership === 'erased') {
		await remove(ctx, a);
		return;
	}
	if (a.superseded) {
		await retireSupersededSetupAppointment(ctx, a, successorHint);
		return;
	}
	if (ownership === 'released' || a.maintenanceRetired) {
		await retireReleasedSetupAppointment(ctx, a);
		return;
	}
	if (ownership === 'paused') {
		await pause(ctx, a, successorHint);
		return;
	}
	if (a.reviewReason && !invalidate) return;
	const pending = pendingSuccessors(a, successorHint);
	if (pending.overflow || a.issue === 'cap') {
		await retainSetupReview(
			ctx,
			{ ...a, pendingSuccessors: pending, successorHint: undefined },
			'cap',
			undefined,
			a.failures,
			invalidate
		);
		return;
	}
	if (a.reviewReason && invalidate && a.reviewReason !== 'evidenceHorizon') {
		await retainSetupReview(
			ctx,
			{ ...a, pendingSuccessors: pending, successorHint: undefined },
			a.reviewReason,
			undefined,
			a.failures,
			true
		);
		return;
	}
	const now = Date.now();
	if (!refreshAdmission(a, invalidate ? 'evidence' : 'routine', now)) return;
	const job = a.refreshJobId
		? await ctx.db.system.get('_scheduled_functions', a.refreshJobId)
		: null;
	let jobRunning = job?.state.kind === 'pending' || job?.state.kind === 'inProgress';
	const abandoned = a.leaseUntil !== undefined && a.leaseUntil <= now;
	if (!invalidate && jobRunning && !abandoned) return;
	if (job?.state.kind === 'pending' && (abandoned || (invalidate && job.scheduledTime > now))) {
		await ctx.scheduler.cancel(job._id);
		jobRunning = false;
	}
	if (abandoned) jobRunning = false;
	// Evidence invalidates a running snapshot; its eventual commit requeues the new generation.
	const refreshJobId = jobRunning
		? a.refreshJobId
		: await ctx.scheduler.runAfter(0, internal.csmSetupAppointments.refresh, { id: a._id });
	await ctx.db.patch('csmSetupAppointments', a._id, {
		generation: a.generation + (invalidate || abandoned ? 1 : 0),
		dirty: a.dirty || invalidate,
		freshUntil: invalidate ? undefined : a.freshUntil,
		reviewReason: invalidate ? undefined : a.reviewReason,
		reviewSession: invalidate ? undefined : a.reviewSession,
		refreshJobId,
		leaseUntil: abandoned ? undefined : a.leaseUntil,
		repairAt: a.leaseUntil && a.leaseUntil > now ? a.leaseUntil : now,
		pendingSuccessors: pending,
		successorHint: undefined
	});
}
async function scheduleDeadline(ctx: MutationCtx, a: Appointment) {
	if ((await ownerState(ctx, a)) === 'released' || a.maintenanceRetired) {
		await retireReleasedSetupAppointment(ctx, a);
		return;
	}
	if (a.reviewReason || pendingSuccessors(a).overflow) return;
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
	const freshUntil = a.freshUntil && a.freshUntil > now ? a.freshUntil : undefined;
	const deadline =
		a.status === 'cancelled'
			? freshUntil
			: end <= now
				? undefined
				: Math.min(end, freshUntil ?? end);
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
	| 'companyId'
	| 'profileId'
	| 'source'
	| 'anchorUid'
	| 'membershipId'
	| 'attemptId'
	| 'providerScope'
	| 'attemptReference'
	| 'legacyReference'
	| 'confirmedBooking'
>;
/** Both admission paths share defaults and job order after their distinct trust checks. */
export async function initializeAppointment(
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
	await enqueue(ctx, row, { successorHint: hint });
	await scheduleDeadline(ctx, row);
	return id;
}
/** Creation confirmation and current appointment state have separate lifetimes. */
export async function seedSetupAppointment(
	ctx: MutationCtx,
	a: Doc<'csmBookingAttempts'>,
	bindCurrent = false
) {
	if (a.mode !== 'setup' || !a.confirmation) return false;
	const ownership = await ownerState(ctx, a);
	if (ownership === 'erased' || ownership === 'paused') return false;
	if (
		await ctx.db
			.query('csmSetupAppointments')
			.withIndex('by_attemptId', (q) => q.eq('attemptId', a._id))
			.unique()
	)
		return false;
	const existing = await represented(ctx, [a.confirmation.uid]);
	if (!existing || existing.length) return false;
	const id = await initializeAppointment(
		ctx,
		{
			companyId: a.companyId,
			profileId: a.profileId,
			membershipId: a.membershipId,
			attemptId: a._id,
			...(a.providerScope ? { providerScope: a.providerScope } : {}),
			...(attemptReference(a) ? { attemptReference: attemptReference(a)! } : {}),
			source: 'native',
			anchorUid: a.confirmation.uid,
			confirmedBooking: { status: 'accepted', ...a.confirmation }
		},
		a.confirmation
	);
	const company = await ctx.db.get('company', a.companyId);
	const source = a.replacement
		? await ctx.db.get('csmSetupAppointments', a.replacement.appointmentId)
		: null;
	// Only fresh settlement binds. Replay/maintenance must never adopt a historical receipt.
	if (
		bindCurrent &&
		company &&
		(a.replacement
			? company.setupAppointmentId === a.replacement.appointmentId &&
				source?.companyId === a.companyId &&
				source.replacementAttemptId === a._id
			: company.setupAppointmentId === undefined)
	) {
		await ctx.db.patch('company', company._id, { setupAppointmentId: id });
		if (source) await retireSupersededSetupAppointment(ctx, source);
	}
	return true;
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
			} else if (ownership === 'released' || a.maintenanceRetired) {
				await retireReleasedSetupAppointment(ctx, a);
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
		const { companyId, company } = await authorize(ctx, membershipId);
		if (company.templateSourceId) return null;
		if (!(await limiter.limit(ctx, 'setupRevisit', { key: companyId })).ok) return null;
		await advanceExpired(ctx, companyId);
		const booking = await resolveSetupBooking(ctx, company);
		const a = 'appointment' in booking ? booking.appointment : await candidate(ctx, companyId);
		if (a) await enqueue(ctx, a, { invalidate: false });
		// Ordinary hidden chains can recover a later missed post-end provider reschedule.
		const hidden = await ctx.db
			.query('csmSetupAppointments')
			.withIndex('by_companyId_and_selection_and_sortAt_and_anchorUid', (q) =>
				q.eq('companyId', companyId).eq('selection', 'hidden')
			)
			.order('desc')
			.first();
		if (hidden && hidden._id !== a?._id) await enqueue(ctx, hidden, { invalidate: false });
		return null;
	}
});
/** HMAC-verified webhooks invalidate facts; only an authenticated provider read replaces them. */
/** Only ingress owns deduplication. Every new obligation is already durable before invalidation. */
export async function notifySetupEvidence(
	ctx: MutationCtx,
	evidence: Doc<'csmWebhookEvidence'>,
	association: { attemptId?: Id<'csmBookingAttempts'> } = {},
	attributedUid?: string
): Promise<Infer<typeof ingressResult>> {
	const hint = evidence.hint;
	if (!hint) return { kind: 'unrelated' };
	let a: Appointment | null = null;
	if (association.attemptId) {
		const attempt = await ctx.db.get('csmBookingAttempts', association.attemptId);
		if (!attempt || attempt.mode !== 'setup' || !attempt.confirmation)
			return { kind: 'needsRetention' };
		await seedSetupAppointment(ctx, attempt);
		a = await ctx.db
			.query('csmSetupAppointments')
			.withIndex('by_attemptId', (q) => q.eq('attemptId', association.attemptId))
			.unique();
	} else
		a =
			(await byUid(ctx, attributedUid ?? hint.uid)) ??
			(hint.previousUid ? await byUid(ctx, hint.previousUid) : null);
	if (!a) return { kind: 'needsRetention' };
	if (evidence.companyId && a.companyId !== evidence.companyId) return { kind: 'needsRetention' };
	// A conflicting native/historical hint stays separate and cannot bind to an unrelated known UID.
	if (hint.reference) {
		const original =
			a.attemptId && !a.attemptReference
				? await ctx.db.get('csmBookingAttempts', a.attemptId)
				: null;
		if (hint.reference !== (a.attemptReference ?? (original ? attemptReference(original) : null)))
			return { kind: 'needsRetention' };
	}
	if (
		hint.historicalReference &&
		a.legacyReference &&
		hint.historicalReference !== a.legacyReference
	)
		return { kind: 'needsRetention' };
	const ownership = await ownerState(ctx, a);
	if (ownership === 'erased') return { kind: 'needsRetention' };
	const evidenceGeneration = (a.evidenceGeneration ?? 0) + 1;
	await ctx.db.patch('csmWebhookEvidence', evidence._id, {
		appointmentId: a._id,
		attemptId: undefined,
		companyId: a.companyId,
		profileId: a.profileId,
		state: 'retained',
		dueAt: undefined,
		leaseUntil: undefined,
		evidenceGeneration,
		generation: evidence.generation + 1
	});
	await ctx.db.patch('csmSetupAppointments', a._id, { evidenceGeneration });
	await enqueue(
		ctx,
		{ ...a, evidenceGeneration },
		{
			invalidate: true,
			successorHint: hint.successorHint ?? (hint.uid !== a.currentUid ? hint.uid : undefined)
		}
	);
	return { kind: 'retained', evidenceId: evidence._id };
}
export const notify = internalMutation({
	args: {
		uid: v.string(),
		attemptId: v.optional(v.id('csmBookingAttempts')),
		companyReference: v.optional(v.string()),
		previousUid: v.optional(v.string()),
		successorHint: v.optional(v.string())
	},
	returns: ingressResult,
	handler: async (ctx, args): Promise<Infer<typeof ingressResult>> => {
		const a = args.attemptId ? await ctx.db.get('csmBookingAttempts', args.attemptId) : null;
		return ctx.runMutation(internal.csmEvidence.ingress, {
			uid: args.uid,
			event: 'RECOVERY_HINT',
			previousUid: args.previousUid,
			successorHint: args.successorHint,
			...(a && attemptReference(a) ? { reference: attemptReference(a)! } : {})
		});
	}
});
export const claimResult = v.union(
	v.null(),
	v.object({
		appointment: schema.doc('csmSetupAppointments'),
		reference: v.optional(v.string()),
		evidenceGeneration: v.number(),
		evidenceIds: v.array(v.id('csmWebhookEvidence')),
		evidenceUids: v.array(v.string())
	})
);
export function setupEvidenceUids(rows: Doc<'csmWebhookEvidence'>[]) {
	return [
		...new Set(
			rows.flatMap((row) =>
				row.hint
					? [row.hint.uid, row.hint.previousUid, row.hint.successorHint].filter(
							(uid): uid is string => uid !== undefined
						)
					: []
			)
		)
	];
}
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
	if (ownership === 'released' || a.maintenanceRetired) {
		await retireReleasedSetupAppointment(ctx, a, 'refresh');
		return null;
	}
	if (ownership === 'paused') {
		await pause(ctx, a, undefined, 'refresh');
		return null;
	}
	// A delayed automatic action cannot disturb a live operator scan or another claim.
	if (a.reviewReason || (a.leaseUntil ?? 0) > Date.now()) return null;
	const pending = pendingSuccessors(a);
	if (pending.overflow || a.issue === 'cap') {
		await retainSetupReview(ctx, a, 'cap', 'refresh');
		return null;
	}
	if (!refreshAdmission(a, expiresAt === undefined ? 'routine' : 'forced', Date.now())) return null;
	const obligations = await appointmentEvidence(ctx, id);
	const evidenceUids = setupEvidenceUids(obligations);
	if (
		obligations.length > 25 ||
		obligations.some((row) => !row.hint) ||
		new Set([a.currentUid, ...pending.uids, ...evidenceUids]).size > 9
	) {
		await retainSetupReview(ctx, a, 'cap', 'refresh');
		return null;
	}
	const attempt =
		a.attemptId && !a.attemptReference ? await ctx.db.get('csmBookingAttempts', a.attemptId) : null;
	const reference = a.attemptReference ?? (attempt ? attemptReference(attempt) : null);
	if (
		!validProviderScope(a.providerScope) ||
		(a.source === 'native' ? !reference : !a.legacyReference)
	) {
		await retainSetupReview(ctx, a, 'missingOriginalProof', 'refresh');
		return null;
	}
	const leaseUntil = Math.min(Date.now() + LEASE_TIME, expiresAt ?? Infinity);
	if (leaseUntil <= Date.now()) return null;
	await ctx.db.patch('csmSetupAppointments', id, {
		lease: a.lease + 1,
		leaseUntil,
		repairAt: leaseUntil,
		pendingSuccessors: pending,
		successorHint: undefined
	});
	return {
		appointment: {
			...a,
			lease: a.lease + 1,
			leaseUntil,
			pendingSuccessors: pending,
			successorHint: undefined
		},
		...(reference ? { reference } : {}),
		evidenceGeneration: a.evidenceGeneration ?? 0,
		evidenceIds: obligations.map((row) => row._id),
		evidenceUids
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
export function compatibleLegacy(
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
export function oldest(rows: Appointment[]) {
	return rows.sort(
		(a, b) => a._creationTime - b._creationTime || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0)
	)[0];
}
function conflictingFacts(a: Appointment, b: ProviderBooking) {
	if (
		b.uid !== a.currentUid &&
		a.providerUpdatedAt !== undefined &&
		b.updatedAt <= a.providerUpdatedAt
	)
		return true;
	const prior =
		b.uid === a.currentUid && a.providerUpdatedAt !== undefined
			? { status: a.status, start: a.start, end: a.end, updatedAt: a.providerUpdatedAt }
			: b.uid === a.confirmedBooking?.uid && a.confirmedBooking.providerUpdatedAt !== undefined
				? { ...a.confirmedBooking, updatedAt: a.confirmedBooking.providerUpdatedAt }
				: null;
	if (!prior) return false;
	const status =
		b.status === 'accepted' ? 'accepted' : b.status === 'pending' ? 'checking' : 'cancelled';
	return (
		b.updatedAt < prior.updatedAt ||
		(b.updatedAt === prior.updatedAt &&
			(b.start !== prior.start || b.end !== prior.end || status !== prior.status))
	);
}

export function validReviewAttestation(a: Infer<typeof setupReviewAttestation>) {
	return [a.operator, a.evidence, a.reason].every(
		(value) => value.trim().length > 0 && value.length <= 2000
	);
}

export const setupProof = v.object({
	...rowArgs,
	generation: v.number(),
	lease: v.number(),
	currentUid: v.string(),
	providerScope,
	reference: v.optional(v.string()),
	legacyReference: v.optional(v.string()),
	evidenceGeneration: v.number(),
	evidenceIds: v.array(v.id('csmWebhookEvidence')),
	reviewed: v.optional(setupReviewAttestation),
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
	if (ownership === 'released' || a.maintenanceRetired) {
		await retireReleasedSetupAppointment(ctx, a, 'refresh');
		return null;
	}
	if (ownership === 'paused') {
		await pause(ctx, a, undefined, 'refresh');
		return null;
	}
	if (a.generation !== args.generation || (a.evidenceGeneration ?? 0) !== args.evidenceGeneration) {
		if (!args.reviewed)
			await enqueue(
				ctx,
				{ ...a, leaseUntil: undefined, refreshJobId: undefined, repairAt: Date.now() },
				{ invalidate: false }
			);
		return null;
	}
	const original =
		a.attemptId && !a.attemptReference ? await ctx.db.get('csmBookingAttempts', a.attemptId) : null;
	if (
		!a.providerScope ||
		a.providerScope.eventTypeId !== args.providerScope.eventTypeId ||
		a.providerScope.organizerId !== args.providerScope.organizerId ||
		(a.attemptReference ?? (original ? attemptReference(original) : undefined) ?? undefined) !==
			args.reference ||
		a.legacyReference !== args.legacyReference
	)
		return null;
	const now = Date.now(),
		pending = pendingSuccessors(a);
	const session = a.reviewSession;
	const reviewed = !!(
		args.reviewed &&
		a.reviewReason &&
		session?.isDone &&
		session.lease === args.lease &&
		session.generation === args.generation &&
		session.evidenceGeneration === args.evidenceGeneration &&
		session.currentUid === args.currentUid &&
		session.expiresAt > now &&
		validReviewAttestation(args.reviewed)
	);
	if ((args.reviewed && !reviewed) || (a.reviewReason && !reviewed)) return null;
	const obligations = reviewed ? [] : await appointmentEvidence(ctx, a._id);
	const evidenceCovered =
		reviewed ||
		(obligations.length <= 25 &&
			obligations.length === args.evidenceIds.length &&
			new Set(args.evidenceIds).size === args.evidenceIds.length &&
			obligations.every((row) => row.hint && args.evidenceIds.includes(row._id)));
	let confirmed = await readConfirmedSetupBooking(ctx, a);
	// Reviewed attestation is the sole exception to bounded graph coverage. All publication fences remain shared.
	let b =
		args.result.kind === 'success' &&
		a.leaseUntil !== undefined &&
		a.leaseUntil > now &&
		evidenceCovered &&
		!args.result.booking.toUid &&
		(reviewed
			? args.result.booking.status !== 'pending'
			: coversSetupProof(
					args.result.proofUids,
					[a.currentUid, args.result.booking.uid, ...setupEvidenceUids(obligations)],
					pending
				))
			? args.result.booking
			: undefined;
	let issue: Infer<typeof setupSyncIssue> =
		args.result.kind === 'failure'
			? args.result.issue
			: pending.overflow || !evidenceCovered
				? 'cap'
				: 'chain';
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
			if (
				reviewed ||
				(await Promise.all(others.map((row) => appointmentEvidence(ctx, row._id)))).some(
					(rows) => rows.length
				)
			) {
				await retainSetupReview(ctx, a, 'conflict', 'refresh');
				return null;
			}
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
				if (survivor._id !== a._id && obligations.length) {
					await retainSetupReview(ctx, a, 'conflict', 'refresh');
					return null;
				}
				confirmed = (await transferSetupAppointment(ctx, affected, survivor)) ?? confirmed;
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
		const failures = deferred ? a.failures : a.failures + 1;
		if (!deferred && (issue !== 'provider' || failures >= EVIDENCE_PASSES)) {
			await retainSetupReview(
				ctx,
				a,
				issue === 'provider' ? 'evidenceHorizon' : issue,
				'refresh',
				failures
			);
			return null;
		}
		await ctx.db.patch('csmSetupAppointments', a._id, {
			leaseUntil: undefined,
			refreshJobId: undefined,
			dirty: a.dirty || (!deferred && issue !== 'provider'),
			failures,
			pendingSuccessors: pending,
			successorHint: undefined,
			issue: deferred ? a.issue : issue,
			repairAt:
				deferred && args.result.kind === 'deferred'
					? Math.max(now + 1, args.result.retryAt)
					: evidenceRetry(failures, now),
			selection: selectionFor(a, now)
		});
		return null;
	}
	if (
		!reviewed &&
		!(await completeAppointmentEvidence(
			ctx,
			a,
			args.evidenceIds,
			args.result.kind === 'success' ? args.result.proofUids : [],
			args.evidenceGeneration
		))
	) {
		await retainSetupReview(ctx, a, 'chain', 'refresh');
		return null;
	}
	const status =
		b.status === 'accepted' ? 'accepted' : b.status === 'pending' ? 'checking' : 'cancelled';
	const ended = Date.parse(b.end) <= now;
	const selection = selectionFor({ ...a, status, end: b.end }, now);
	const freshUntil =
		status === 'accepted'
			? now + ACTIVE_INTERVAL
			: status === 'cancelled'
				? now + CANCELLED_INTERVAL
				: undefined;
	await ctx.db.patch('csmSetupAppointments', a._id, {
		currentUid: b.uid,
		start: b.start,
		end: b.end,
		status,
		confirmedBooking:
			status === 'checking'
				? (confirmed ?? undefined)
				: {
						status,
						uid: b.uid,
						start: b.start,
						end: b.end,
						confirmedAt: now,
						providerUpdatedAt: b.updatedAt
					},
		bookingConfirmation: undefined,
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
		reviewReason: undefined,
		reviewSession: undefined,
		...(reviewed && args.reviewed && session
			? {
					reviewedResolution: {
						...args.reviewed,
						at: now,
						generation: args.generation,
						evidenceGeneration: args.evidenceGeneration,
						inspected: session.inspected,
						lease: args.lease
					}
				}
			: {}),
		pendingSuccessors: { uids: [], overflow: false },
		successorHint: undefined,
		repairAt:
			status === 'cancelled'
				? now + CANCELLED_INTERVAL
				: status === 'accepted' && ended
					? undefined
					: Math.min(now + ACTIVE_INTERVAL, ended ? now + ACTIVE_INTERVAL : Date.parse(b.end))
	});
	if (reviewed)
		await ctx.scheduler.runAfter(0, internal.csmSetupReview.completeEvidence, {
			id: a._id,
			evidenceGeneration: args.evidenceGeneration,
			lease: args.lease
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
	deadline: number
) {
	const a = snapshot.appointment;
	const pending = pendingSuccessors(a);
	pending.uids = [...new Set([...pending.uids, ...snapshot.evidenceUids])].filter(
		(uid) => uid !== a.currentUid
	);
	return proveSetupChain(a.currentUid, pending, async (uid) => {
		// A quota failure immediately becomes a durable deferral, without spending a pass.
		if (Date.now() + 12_000 > deadline) throw new SetupDeferredError(Date.now() + 60_000);
		const raw = await calRead(ctx, `bookings/${encodeURIComponent(uid)}`, '2026-02-25');
		const booking = parseSetupBooking(raw, uid, {
			companyId: a.companyId,
			profileId: a.profileId,
			attemptReference: snapshot.reference,
			providerScope: a.providerScope,
			legacyReference: a.legacyReference
		});
		if (!booking) throw new SetupChainError('chain');
		return booking;
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
		const result = await readSetupProof(ctx, snapshot, a.leaseUntil! - 15_000);
		await ctx.runMutation(internal.csmSetupAppointments.commit, {
			id,
			generation: a.generation,
			lease: a.lease,
			currentUid: a.currentUid,
			providerScope: a.providerScope!,
			...(snapshot.reference ? { reference: snapshot.reference } : {}),
			...(a.legacyReference ? { legacyReference: a.legacyReference } : {}),
			evidenceGeneration: snapshot.evidenceGeneration,
			evidenceIds: snapshot.evidenceIds,
			result:
				result.kind === 'success'
					? { kind: 'success', booking: result.booking, proofUids: result.proofUids }
					: result
		});
		return null;
	}
});
/** Sync deadlines advance repair state; confirmed booking facts do not expire. */
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
		if (ownership === 'released' || a.maintenanceRetired) {
			await retireReleasedSetupAppointment(ctx, a, 'deadline');
			return null;
		}
		if (ownership === 'paused') {
			await pause(ctx, a, undefined, 'deadline');
			return null;
		}
		if (a.status !== 'cancelled' && Date.parse(a.end) <= Date.now())
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
			else if (ownership === 'released' || a.maintenanceRetired)
				await retireReleasedSetupAppointment(ctx, a);
			else if (ownership === 'paused') await pause(ctx, a);
			else await enqueue(ctx, a, { invalidate: false });
		}
		return null;
	}
});
export const retireReleased = internalMutation({
	args: { companyId: v.id('company'), cursor: v.union(v.string(), v.null()) },
	returns: v.null(),
	handler: async (ctx, { companyId, cursor }) => {
		await retireCompanySetupAppointments(ctx, companyId, cursor);
		return null;
	}
});
/** Old scheduled invocations are transported into the same durable inbox. */
export const legacyWebhook = internalAction({
	args: {
		reference: v.string(),
		uid: v.string(),
		previousUid: v.optional(v.string()),
		successorHint: v.optional(v.string())
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.runMutation(internal.csmEvidence.ingress, {
			uid: args.uid,
			event: 'RECOVERY_HINT',
			historicalReference: args.reference,
			previousUid: args.previousUid,
			successorHint: args.successorHint
		});
		return null;
	}
});
