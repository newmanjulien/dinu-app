import { ConvexError, v, type Infer } from 'convex/values';
import { RateLimiter } from '@convex-dev/rate-limiter';
import { components, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
	action,
	env,
	httpAction,
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
	query,
	type MutationCtx,
	type QueryCtx,
	type ActionCtx
} from './_generated/server';
import {
	availableCompany,
	liveProfile,
	requireMembership,
	requirePermission,
	verifiedIdentity,
	type CompanyAccess
} from './auth';
import { readTextBody } from './uploadHttp';
import { assertPermission } from './permissions';
import schema from './schema';
import { retireSupersededSetupAppointment } from './csmSetupLifecycle';
import {
	seedSetupAppointment,
	claimSetupAppointment,
	claimResult,
	applySetupProof,
	setupProof,
	readSetupProof
} from './csmSetupAppointments';
import {
	replacementProgress,
	replacementSource,
	replacementState,
	sharedReplacement,
	sameReplacement,
	type Replacement
} from './csmReplacements';
import {
	attemptView,
	availabilityResult,
	bookingError,
	bookingMode,
	providerBooking,
	bookingAck,
	failureBasis,
	terminalProof
} from './csmBookingValidators';
import { setupReplacement } from './csmBookingValidators';
import {
	attemptReference,
	companyReference,
	sourceReference,
	parseCompanyReference,
	verifySignature,
	object,
	iso,
	validTimeZone,
	validBookingUid,
	dateInZone,
	configuration,
	slots,
	calRead,
	calRequest,
	parseBooking,
	parseSetupBooking,
	noncreatingRejection,
	EVENT_ID,
	HOST,
	EVENT_SLUG,
	type ProviderBooking,
	type BookingMode
} from './csmCal';

type Attempt = Doc<'csmBookingAttempts'>;
const attemptArgs = { attemptId: v.id('csmBookingAttempts') };
const memberArgs = { membershipId: v.id('memberships') };
const operatorEvidence = {
	expectedRevision: v.number(),
	operator: v.string(),
	evidence: v.string(),
	reason: v.string()
};
function validOperator(a: { operator: string; evidence: string; reason: string } | undefined) {
	return !!a && [a.operator, a.evidence, a.reason].every((s) => !!s.trim() && s.length <= 2000);
}
const limiter = new RateLimiter(components.rateLimiter, {
	calendar: { kind: 'token bucket', rate: 12, period: 60_000, capacity: 8 },
	status: { kind: 'token bucket', rate: 4, period: 60_000, capacity: 2 },
	book: { kind: 'token bucket', rate: 3, period: 60_000, capacity: 3 }
});
const pendingStates = ['queued', 'submitting', 'unknown'] as const;
function view(a: Attempt): Infer<typeof attemptView> {
	return {
		id: a._id,
		operationId: a.operationId,
		mode: a.mode,
		...(a.replacement ? { replacement: a.replacement } : {}),
		state: a.state,
		requestedStart: a.requestedStart,
		start:
			a.confirmation?.start ??
			a.lineage?.find((b) => b.uid === a.providerUid)?.start ??
			a.requestedStart,
		timeZone: a.timeZone,
		error: a.error ?? null
	};
}
async function pending(ctx: QueryCtx, membershipId: Id<'memberships'>) {
	for (const state of pendingStates) {
		const row = await ctx.db
			.query('csmBookingAttempts')
			.withIndex('by_membershipId_and_state', (q) =>
				q.eq('membershipId', membershipId).eq('state', state)
			)
			.first();
		if (row) return row;
	}
	return null;
}
function assertDisplayAccess(a: CompanyAccess, mode: BookingMode, replacement?: Replacement) {
	if (mode === 'setup') assertPermission(a.membership.role, 'manageTemplate', a.isOwner);
	if (replacement) {
		if (mode !== 'setup') throw new ConvexError('This setup call is unavailable.');
		return;
	}
	if (
		(mode === 'setup' && a.company.csmCallBookedAt !== undefined) ||
		(mode === 'support' && a.company.csmCallBookedAt === undefined)
	)
		throw new ConvexError('Your booking access has changed. Close this window and reopen it.');
}
function assertAccess(a: CompanyAccess, mode: BookingMode, replacement?: Replacement) {
	assertDisplayAccess(a, mode, replacement);
	if (mode === 'setup' && !a.company.baselineId)
		throw new ConvexError('Your booking access has changed. Close this window and reopen it.');
}
async function stillEligible(ctx: QueryCtx, a: Attempt) {
	const [profile, company, member] = await Promise.all([
		liveProfile(ctx, a.profileId),
		availableCompany(ctx, a.companyId),
		ctx.db.get('memberships', a.membershipId)
	]);
	const memberEligible =
		!!profile &&
		!!company &&
		member?.profileId === a.profileId &&
		member.companyId === a.companyId &&
		(a.mode === 'setup'
			? member.role === 'admin' &&
				!!company.baselineId &&
				(a.replacement !== undefined || company.csmCallBookedAt === undefined)
			: company.csmCallBookedAt !== undefined);
	if (!memberEligible || !a.replacement) return memberEligible;
	const source = await ctx.db.get('csmSetupAppointments', a.replacement.appointmentId);
	return (
		!!source &&
		source.companyId === a.companyId &&
		source.currentUid === a.replacement.currentUid &&
		source.status === 'cancelled' &&
		!source.superseded &&
		!source.erasedReplacementUncertain &&
		source.replacementAttemptId === a._id &&
		!!(await liveProfile(ctx, source.profileId))
	);
}
async function owned(
	ctx: QueryCtx,
	membershipId: Id<'memberships'>,
	attemptId: Id<'csmBookingAttempts'>,
	a?: CompanyAccess
) {
	a ??= await requireMembership(ctx, membershipId);
	const row = await ctx.db.get('csmBookingAttempts', attemptId);
	if (
		!row ||
		row.membershipId !== membershipId ||
		row.profileId !== a.profile._id ||
		row.companyId !== a.companyId
	)
		throw new ConvexError('Booking is unavailable.');
	return row;
}
export const authorize = internalQuery({
	args: { ...memberArgs, mode: bookingMode, replacement: v.optional(setupReplacement) },
	returns: v.null(),
	handler: async (ctx, a) => {
		// Display reads may warm setup before a baseline exists. New bookings remain strict.
		const owner = await requireMembership(ctx, a.membershipId);
		assertDisplayAccess(owner, a.mode, a.replacement);
		if (a.replacement && (await sharedReplacement(ctx, owner, a.replacement)).state !== 'ready')
			throw new ConvexError('This setup call is being updated. Please check its status.');
		return null;
	}
});
/** Legacy references remain readable by old clients; unresolved native sends cannot issue new links. */
export const context = query({
	args: { ...memberArgs, mode: bookingMode },
	returns: v.string(),
	handler: async (ctx, a) => {
		const owner =
			a.mode === 'setup'
				? await requirePermission(ctx, 'manageTemplate', a.membershipId)
				: await requireMembership(ctx, a.membershipId);
		if (!env.CAL_WEBHOOK_SECRET || (await pending(ctx, a.membershipId)))
			throw new ConvexError('Booking is temporarily unavailable.');
		return sourceReference(owner.companyId, a.mode, owner.profile._id);
	}
});
export const availability = action({
	args: {
		...memberArgs,
		mode: bookingMode,
		month: v.string(),
		timeZone: v.string(),
		replacement: v.optional(setupReplacement)
	},
	returns: availabilityResult,
	handler: async (ctx, a): Promise<Infer<typeof availabilityResult>> => {
		await ctx.runQuery(internal.csmBookings.authorize, {
			membershipId: a.membershipId,
			mode: a.mode,
			...(a.replacement ? { replacement: a.replacement } : {})
		});
		if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(a.month) || !validTimeZone(a.timeZone))
			throw new ConvexError('Invalid calendar date or timezone.');
		const start = Date.parse(a.month + '-01T00:00:00Z');
		if (start < Date.now() - 40 * 86_400_000 || start > Date.now() + 370 * 86_400_000)
			throw new ConvexError('Choose a nearer month.');
		await limiter.limit(ctx, 'calendar', { key: a.membershipId, throws: true });
		if (!env.CAL_WEBHOOK_SECRET || !env.CAL_API_KEY)
			return { status: 'unavailable', slots: [], duration: 0, lastDate: null };
		const end = new Date(start);
		end.setUTCMonth(end.getUTCMonth() + 1);
		// Attach both handlers immediately; invalid configuration must not wait for slots.
		const configRead = configuration(ctx);
		const slotRead = slots(
			ctx,
			new Date(start - 86_400_000).toISOString(),
			new Date(+end + 86_400_000).toISOString(),
			a.timeZone
		).then(
			(value) => ({ value }),
			(error: unknown) => ({ error })
		);
		const config = await configRead;
		if (!config) return { status: 'unavailable', slots: [], duration: 0, lastDate: null };
		const outcome = await slotRead;
		if ('error' in outcome) throw outcome.error;
		const result = outcome.value;
		if (result.some((s) => Date.parse(s.end) - Date.parse(s.start) !== config.duration * 60_000))
			throw new ConvexError('Invalid calendar duration.');
		const date = dateInZone(a.timeZone);
		return {
			status: 'ready',
			duration: config.duration,
			lastDate: config.lastDate,
			slots: result.filter((s) => date(s.start).startsWith(a.month))
		};
	}
});
export const attempt = query({
	args: {
		...memberArgs,
		attemptId: v.optional(v.id('csmBookingAttempts')),
		replacement: v.optional(setupReplacement)
	},
	returns: v.union(attemptView, v.null()),
	handler: async (ctx, a) => {
		const owner = await requireMembership(ctx, a.membershipId);
		const row = a.attemptId
			? await owned(ctx, a.membershipId, a.attemptId, owner)
			: await pending(ctx, a.membershipId);
		if (a.replacement && row && !sameReplacement(row.replacement, a.replacement)) return null;
		return row ? view(row) : null;
	}
});
export const book = mutation({
	args: {
		...memberArgs,
		mode: bookingMode,
		operationId: v.string(),
		start: v.string(),
		timeZone: v.string(),
		replacement: v.optional(setupReplacement),
		receiptProtocol: v.optional(v.literal('creation-v1'))
	},
	returns: v.union(bookingAck, attemptView),
	handler: async (ctx, a): Promise<Infer<typeof bookingAck> | Infer<typeof attemptView>> => {
		const owner = await requireMembership(ctx, a.membershipId);
		const acknowledge = (row: Attempt) =>
			a.receiptProtocol === 'creation-v1'
				? { attemptId: row._id, operationId: row.operationId }
				: view(row);
		if (!/^[a-zA-Z0-9-]{16,100}$/.test(a.operationId))
			throw new ConvexError('Invalid booking operation.');
		const prior = await ctx.db
			.query('csmBookingAttempts')
			.withIndex('by_membershipId_and_operationId', (q) =>
				q.eq('membershipId', a.membershipId).eq('operationId', a.operationId)
			)
			.unique();
		if (prior) {
			if (
				(a.replacement || prior.replacement) &&
				(prior.mode !== a.mode ||
					prior.requestedStart !== a.start ||
					prior.timeZone !== a.timeZone ||
					!sameReplacement(prior.replacement, a.replacement))
			)
				throw new ConvexError(
					'This booking operation has changed. Close this window and try again.'
				);
			return acknowledge(prior);
		}
		const unresolved = await pending(ctx, a.membershipId);
		if (unresolved) {
			if (
				(a.replacement || unresolved.replacement) &&
				(unresolved.mode !== a.mode || !sameReplacement(unresolved.replacement, a.replacement))
			)
				throw new ConvexError(
					'Another booking is still being confirmed. Open the booking widget to check it.'
				);
			return acknowledge(unresolved);
		}
		const start = iso(a.start);
		if (
			!start ||
			start !== a.start ||
			Date.parse(start) <= Date.now() ||
			Date.parse(start) > Date.now() + 370 * 86_400_000 ||
			!validTimeZone(a.timeZone)
		)
			throw new ConvexError('Choose an available time.');
		// Old failed rows have no ordered noncreation evidence. Maintenance must classify them
		// before this member can create more work; exact replay and recovery remain available.
		const unclassified = await ctx.db
			.query('csmBookingAttempts')
			.withIndex('by_membershipId_and_state_and_failureBasis', (q) =>
				q.eq('membershipId', a.membershipId).eq('state', 'failed').eq('failureBasis', undefined)
			)
			.first();
		if (unclassified)
			throw new ConvexError('An earlier booking needs to be checked. Please contact support.');
		// Stale SPA modules can replay old work, but may not create through the old protocol.
		if (a.receiptProtocol !== 'creation-v1')
			throw new ConvexError('Please reload this page fully before booking a call.');
		assertAccess(owner, a.mode, a.replacement);
		if (a.replacement) {
			const source = await replacementSource(ctx, owner, a.replacement);
			if (
				source.currentUid !== a.replacement.currentUid ||
				(await replacementState(ctx, source)).state !== 'ready'
			)
				throw new ConvexError('This setup call is being updated. Please check its status.');
		}
		if (!env.CAL_API_KEY || !env.CAL_WEBHOOK_SECRET)
			throw new ConvexError('Booking is temporarily unavailable.');
		await limiter.limit(ctx, 'book', { key: a.membershipId, throws: true });
		if (a.replacement)
			await limiter.limit(ctx, 'book', { key: a.replacement.appointmentId, throws: true });
		const identity = await verifiedIdentity(ctx);
		const email = identity.email.trim().toLowerCase();
		const name =
			owner.profile.name.trim() ||
			email
				.split('@')[0]
				.replace(/[._+-]+/g, ' ')
				.trim() ||
			'Guest';
		const id = await ctx.db.insert('csmBookingAttempts', {
			companyId: owner.companyId,
			profileId: owner.profile._id,
			membershipId: a.membershipId,
			mode: a.mode,
			...(a.replacement ? { replacement: a.replacement } : {}),
			operationId: a.operationId,
			requestedStart: start,
			timeZone: a.timeZone,
			attendeeName: name.slice(0, 200),
			attendeeEmail: email,
			state: 'queued',
			revision: 0,
			updatedAt: Date.now()
		});
		if (a.replacement)
			await ctx.db.patch('csmSetupAppointments', a.replacement.appointmentId, {
				replacementAttemptId: id
			});
		const sendJobId = await ctx.scheduler.runAfter(0, internal.csmBookings.send, { attemptId: id });
		const watchdogJobId = await ctx.scheduler.runAfter(55_000, internal.csmBookings.watch, {
			attemptId: id,
			round: 0
		});
		await ctx.db.patch('csmBookingAttempts', id, { sendJobId, watchdogJobId });
		return acknowledge((await ctx.db.get('csmBookingAttempts', id))!);
	}
});
export const read = internalQuery({
	args: attemptArgs,
	returns: v.union(schema.doc('csmBookingAttempts'), v.null()),
	handler: async (ctx, { attemptId }) => {
		const a = await ctx.db.get('csmBookingAttempts', attemptId);
		return a && (await liveProfile(ctx, a.profileId)) && (await availableCompany(ctx, a.companyId))
			? { ...a, lineage: a.lineage ?? [] }
			: null;
	}
});
export const readOwned = internalQuery({
	args: { ...memberArgs, ...attemptArgs },
	returns: schema.doc('csmBookingAttempts'),
	handler: (ctx, a) => owned(ctx, a.membershipId, a.attemptId)
});
async function patch(
	ctx: MutationCtx,
	a: Attempt,
	fields: Partial<Infer<typeof import('./csmBookingValidators').storedCsmAttempt>>
) {
	await ctx.db.patch('csmBookingAttempts', a._id, {
		...fields,
		revision: a.revision + 1,
		updatedAt: Date.now()
	});
}
export const claim = internalMutation({
	args: { ...attemptArgs, replacementProof: v.optional(setupProof) },
	returns: v.boolean(),
	handler: async (ctx, { attemptId, replacementProof }) => {
		const a = await ctx.db.get('csmBookingAttempts', attemptId);
		if (!a || a.state !== 'queued') return false;
		if (
			!(await stillEligible(ctx, a)) ||
			Date.now() > a._creationTime + 45_000 ||
			!a.attendeeName ||
			!a.attendeeEmail
		) {
			await patch(ctx, a, { state: 'failed', error: 'access', failureBasis: 'queuedPreflight' });
			return false;
		}
		if (a.replacement) {
			const proof = replacementProof;
			const source = await ctx.db.get('csmSetupAppointments', a.replacement.appointmentId);
			if (
				!proof ||
				!source ||
				proof.id !== source._id ||
				proof.currentUid !== a.replacement.currentUid ||
				proof.generation !== source.generation ||
				proof.lease !== source.lease ||
				proof.result.kind !== 'success'
			) {
				await patch(ctx, a, {
					state: 'failed',
					error: 'unavailable',
					failureBasis: 'queuedPreflight'
				});
				return false;
			}
			// The refresh and replacement sender share proof coverage, revision, ownership and merge rules.
			await applySetupProof(ctx, proof);
			const committed = await ctx.db.get('csmSetupAppointments', source._id);
			if (
				!committed ||
				committed.dirty ||
				committed.generation !== proof.generation ||
				committed.providerUpdatedAt !== proof.result.booking.updatedAt ||
				!(await stillEligible(ctx, a))
			) {
				await patch(ctx, a, { state: 'failed', error: 'access', failureBasis: 'queuedPreflight' });
				return false;
			}
		}
		await patch(ctx, a, { state: 'submitting' });
		return true;
	}
});
export const beginReplacementProof = internalMutation({
	args: attemptArgs,
	returns: claimResult,
	handler: async (ctx, { attemptId }): Promise<Infer<typeof claimResult>> => {
		const a = await ctx.db.get('csmBookingAttempts', attemptId);
		if (!a || a.state !== 'queued' || !a.replacement || !(await stillEligible(ctx, a))) return null;
		return claimSetupAppointment(ctx, a.replacement.appointmentId, a._creationTime + 45_000);
	}
});
/** A failed preflight must not hold the source lease for the rest of its queued window. */
export const releaseReplacementProof = internalMutation({
	args: { ...attemptArgs, lease: v.number() },
	returns: v.null(),
	handler: async (ctx, { attemptId, lease }) => {
		const a = await ctx.db.get('csmBookingAttempts', attemptId);
		const source = a?.replacement
			? await ctx.db.get('csmSetupAppointments', a.replacement.appointmentId)
			: null;
		if (!a?.replacement || !source || source.companyId !== a.companyId) return null;
		if (source.superseded) {
			await retireSupersededSetupAppointment(ctx, source);
			return null;
		}
		// The token owns cleanup even after a safe retry advances the reservation pointer.
		if (source.lease !== lease || source.leaseUntil === undefined) return null;
		await ctx.db.patch('csmSetupAppointments', source._id, {
			leaseUntil: undefined,
			repairAt: Date.now() + 60_000
		});
		return null;
	}
});
/** Legacy callers cannot assert that a claimed request was never dispatched. */
export const fail = internalMutation({
	args: {
		...attemptArgs,
		error: bookingError,
		dispatched: v.boolean(),
		basis: v.optional(failureBasis)
	},
	returns: v.null(),
	handler: async (ctx, { attemptId, error, dispatched, basis }) => {
		const a = await ctx.db.get('csmBookingAttempts', attemptId);
		if (!a || !pendingStates.some((s) => s === a.state)) return null;
		const safe =
			!dispatched &&
			((a.state === 'queued' && (!basis || basis === 'queuedPreflight')) ||
				(basis === 'claimedPredispatch' && a.state === 'submitting') ||
				(basis === 'providerRejection' && (a.state === 'submitting' || a.state === 'unknown')));
		await patch(ctx, a, {
			state: safe ? 'failed' : 'unknown',
			error,
			failureBasis: safe ? (basis ?? 'queuedPreflight') : undefined
		});
		return null;
	}
});
async function observeSender(ctx: MutationCtx, a: Attempt) {
	let terminal = a.senderTerminal;
	if (!terminal && a.sendJobId) {
		const job = await ctx.db.system.get('_scheduled_functions', a.sendJobId);
		if (job && !['pending', 'inProgress'].includes(job.state.kind))
			terminal = { kind: job.state.kind, observedAt: Date.now() };
	}
	if (terminal)
		await ctx.db.patch('csmBookingAttempts', a._id, {
			senderTerminal: terminal,
			attendeeName: undefined,
			...(a.state === 'booked' && a.confirmation ? { attendeeEmail: undefined } : {})
		});
	return terminal;
}
function proofFor(a: Attempt): Infer<typeof terminalProof> | undefined {
	return a.sendJobId && a.senderTerminal
		? { attemptId: a._id, sendJobId: a.sendJobId, ...a.senderTerminal }
		: undefined;
}
async function liveAttempt(ctx: QueryCtx, a: Attempt) {
	return !!(await liveProfile(ctx, a.profileId)) && !!(await availableCompany(ctx, a.companyId));
}
const recoverySnapshot = v.union(
	v.object({ attempt: schema.doc('csmBookingAttempts'), proof: v.optional(terminalProof) }),
	v.null()
);
type Recovery = Infer<typeof recoverySnapshot>;
/** Observe execution before any provider facts that might release the unresolved guard. */
export const beginRecovery = internalMutation({
	args: attemptArgs,
	returns: recoverySnapshot,
	handler: async (ctx, { attemptId }): Promise<Recovery> => {
		const a = await ctx.db.get('csmBookingAttempts', attemptId);
		if (!a || !(await liveAttempt(ctx, a))) return null;
		await observeSender(ctx, a);
		const updated = (await ctx.db.get('csmBookingAttempts', attemptId))!;
		return { attempt: updated, proof: proofFor(updated) };
	}
});
function sameProof(a: Attempt, proof: Infer<typeof terminalProof> | undefined) {
	const current = proofFor(a);
	return (
		!!proof &&
		!!current &&
		proof.attemptId === current.attemptId &&
		proof.sendJobId === current.sendJobId &&
		proof.kind === current.kind &&
		proof.observedAt === current.observedAt
	);
}
/** Only the scoped provider adapter supplies these attestations; old normalized arrays cannot. */
export const settleCreation = internalMutation({
	args: {
		...attemptArgs,
		reference: v.string(),
		attendeeEmail: v.string(),
		anchorUid: v.string(),
		booking: providerBooking,
		source: v.union(v.literal('dispatch'), v.literal('recovery'), v.literal('operator')),
		operatorEvidence: v.optional(v.object(operatorEvidence)),
		proof: v.optional(terminalProof)
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const a = await ctx.db.get('csmBookingAttempts', args.attemptId);
		if (
			args.source === 'operator' &&
			(!a ||
				a.state !== 'unknown' ||
				!a.senderTerminal ||
				a.revision !== args.operatorEvidence?.expectedRevision ||
				!validOperator(args.operatorEvidence))
		)
			throw new ConvexError(
				'The attempt changed or operator evidence is missing. Inspect it again.'
			);
		if (
			!a ||
			a.state === 'booked' ||
			!(await liveAttempt(ctx, a)) ||
			args.reference !== attemptReference(a) ||
			!a.attendeeEmail ||
			args.attendeeEmail !== a.attendeeEmail ||
			!validBookingUid(args.anchorUid)
		)
			return null;
		const b = args.booking;
		if (args.source === 'operator' && (b.status !== 'accepted' || args.anchorUid !== b.uid))
			return null;
		if (
			!validBookingUid(b.uid) ||
			iso(b.start) !== b.start ||
			iso(b.end) !== b.end ||
			b.end <= b.start
		)
			return null;
		if (
			args.source === 'dispatch' &&
			((a.state !== 'submitting' && a.state !== 'unknown') ||
				b.start !== a.requestedStart ||
				args.anchorUid !== b.uid)
		)
			return null;
		if (b.status === 'accepted') {
			await patch(ctx, a, {
				state: 'booked',
				error: undefined,
				failureBasis: undefined,
				confirmation: { uid: b.uid, start: b.start, end: b.end, confirmedAt: Date.now() },
				providerUid: undefined,
				lineage: undefined,
				reviewRequired: undefined,
				...(a.senderTerminal ? { attendeeName: undefined, attendeeEmail: undefined } : {})
			});
			if (args.source === 'operator' && args.operatorEvidence) {
				const { operator, evidence, reason } = args.operatorEvidence;
				await ctx.db.patch('csmBookingAttempts', a._id, {
					operatorResolution: { operator, evidence, reason, at: Date.now() }
				});
			}
			if (a.mode === 'setup') {
				const company = await availableCompany(ctx, a.companyId);
				if (company && company.csmCallBookedAt === undefined)
					await ctx.db.patch('company', a.companyId, { csmCallBookedAt: Date.now() });
			}
			await seedSetupAppointment(ctx, (await ctx.db.get('csmBookingAttempts', a._id))!);
		} else if (a.state !== 'failed') {
			const refused =
				(b.status === 'cancelled' || b.status === 'rejected') && sameProof(a, args.proof);
			await patch(ctx, a, {
				state: refused ? 'failed' : 'unknown',
				error: refused ? 'cancelled' : 'uncertain',
				failureBasis: refused ? 'providerTerminal' : undefined,
				providerUid: b.uid,
				lineage: undefined,
				reviewRequired: undefined
			});
		}
		return null;
	}
});
/** Compatibility only: old payloads are bounded locators, never booking/negative authority. */
export const settle = internalMutation({
	args: { ...attemptArgs, bookings: v.array(providerBooking) },
	returns: v.null(),
	handler: async (ctx, { attemptId, bookings }) => {
		const a = await ctx.db.get('csmBookingAttempts', attemptId);
		if (
			a &&
			a.state !== 'booked' &&
			bookings.length > 0 &&
			bookings.length <= 9 &&
			bookings.every((b) => validBookingUid(b.uid)) &&
			(await liveAttempt(ctx, a))
		)
			await ctx.scheduler.runAfter(0, internal.csmBookings.recoverWebhook, {
				reference: attemptReference(a),
				uid: bookings[0].uid
			});
		return null;
	}
});
export const observe = internalMutation({
	args: attemptArgs,
	returns: v.null(),
	handler: async (ctx, { attemptId }) => {
		const a = await ctx.db.get('csmBookingAttempts', attemptId);
		if (a) await observeSender(ctx, a);
		return null;
	}
});
export const watch = internalMutation({
	args: { ...attemptArgs, round: v.number() },
	returns: v.null(),
	handler: async (ctx, { attemptId, round }) => {
		const a = await ctx.db.get('csmBookingAttempts', attemptId);
		if (!a) return null;
		const terminal = await observeSender(ctx, a);
		if (a.state === 'queued')
			await patch(ctx, a, { state: 'failed', error: 'interrupted', failureBasis: 'queuedExpired' });
		else if (a.state === 'submitting')
			await patch(ctx, a, { state: 'unknown', error: 'uncertain' });
		if (!terminal && round < 24) {
			const job = await ctx.scheduler.runAfter(30_000, internal.csmBookings.watch, {
				attemptId,
				round: round + 1
			});
			await ctx.db.patch('csmBookingAttempts', attemptId, { watchdogJobId: job });
		}
		return null;
	}
});
export const send = internalAction({
	args: attemptArgs,
	returns: v.null(),
	handler: async (ctx, { attemptId }) => {
		const a: Attempt | null = await ctx.runQuery(internal.csmBookings.read, { attemptId });
		if (!a || a.state !== 'queued') return null;
		let claimed = false,
			claimStarted = false,
			dispatched = false;
		let sourceLease: number | undefined;
		try {
			if (!a.attendeeEmail || !a.attendeeName) throw new Error('Missing immutable identity.');
			let replacementProof: Infer<typeof setupProof> | undefined;
			const deadline = a._creationTime + 43_000;
			const requireReadBudget = () => {
				if (a.replacement && Date.now() + 12_000 > deadline) throw new Error('Preflight expired.');
			};
			if (a.replacement) {
				const snapshot: Infer<typeof claimResult> = await ctx.runMutation(
					internal.csmBookings.beginReplacementProof,
					{ attemptId }
				);
				if (!snapshot) throw new Error('Setup call changed.');
				sourceLease = snapshot.appointment.lease;
				const result = await readSetupProof(ctx, snapshot, deadline);
				const source = snapshot.appointment;
				replacementProof = {
					id: source._id,
					generation: source.generation,
					lease: source.lease,
					currentUid: source.currentUid,
					result:
						result.kind === 'success'
							? { kind: 'success', booking: result.booking, proofUids: result.proofUids }
							: result
				};
				// Corrected provider state must still be published when the source has a real successor.
				if (
					result.kind !== 'success' ||
					result.booking.uid !== a.replacement.currentUid ||
					(result.booking.status !== 'cancelled' && result.booking.status !== 'rejected')
				) {
					await ctx.runMutation(internal.csmBookings.claim, { attemptId, replacementProof });
					await ctx.runMutation(internal.csmBookings.fail, {
						attemptId,
						error: 'unavailable',
						dispatched: false,
						basis: 'queuedPreflight'
					});
					return null;
				}
			}
			requireReadBudget();
			const config = await configuration(ctx);
			if (!config) {
				await ctx.runMutation(internal.csmBookings.fail, {
					attemptId,
					error: 'unavailable',
					dispatched: false,
					basis: 'queuedPreflight'
				});
				return null;
			}
			requireReadBudget();
			const times = await slots(
				ctx,
				a.requestedStart,
				new Date(Date.parse(a.requestedStart) + 86_400_000).toISOString(),
				a.timeZone,
				config.duration
			);
			if (!times.some((s) => s.start === a.requestedStart)) {
				await ctx.runMutation(internal.csmBookings.fail, {
					attemptId,
					error: 'conflict',
					dispatched: false,
					basis: 'queuedPreflight'
				});
				return null;
			}
			const metadata = {
				dinuCsmReference: companyReference(a.companyId, a.mode),
				dinuCsmAttempt: attemptReference(a)
			};
			claimStarted = true;
			claimed = await ctx.runMutation(internal.csmBookings.claim, {
				attemptId,
				...(replacementProof ? { replacementProof } : {})
			});
			if (!claimed) return null;
			// One app-controlled POST; neither a timeout nor a lost mutation acknowledgement retries it.
			const response = await calRequest(
				ctx,
				'bookings',
				'2026-02-25',
				{
					eventTypeId: EVENT_ID,
					start: a.requestedStart,
					lengthInMinutes: config.duration,
					attendee: {
						name: a.attendeeName,
						email: a.attendeeEmail,
						timeZone: a.timeZone,
						language: 'en'
					},
					location: config.location,
					metadata
				},
				() => {
					dispatched = true;
				}
			);
			const rejection = noncreatingRejection(response.status, response.body);
			if (rejection) {
				await ctx.runMutation(internal.csmBookings.fail, {
					attemptId,
					error: rejection,
					dispatched: false,
					basis: 'providerRejection'
				});
				return null;
			}
			const b =
				response.ok && object(response.body) && response.body.status === 'success'
					? parseBooking(response.body.data, a.attendeeEmail)
					: null;
			if (!b || b.start !== a.requestedStart) throw new Error('Uncertain provider response.');
			// A terminal refusal returned while the sender is running cannot prove the POST is finished.
			await ctx.runMutation(internal.csmBookings.settleCreation, {
				attemptId,
				reference: metadata.dinuCsmAttempt,
				attendeeEmail: a.attendeeEmail,
				anchorUid: b.uid,
				booking: b,
				source: 'dispatch'
			});
		} catch {
			if (claimStarted && !claimed) return null;
			await ctx.runMutation(internal.csmBookings.fail, {
				attemptId,
				error: dispatched ? 'uncertain' : 'unavailable',
				dispatched,
				...(dispatched
					? {}
					: { basis: claimed ? ('claimedPredispatch' as const) : ('queuedPreflight' as const) })
			});
		} finally {
			if (sourceLease !== undefined)
				await ctx.runMutation(internal.csmBookings.releaseReplacementProof, {
					attemptId,
					lease: sourceLease
				});
		}
		return null;
	}
});
/** A bounded, fresh read of unresolved creation only. No appointment graph is persisted. */
async function reconcile(
	ctx: ActionCtx,
	attemptId: Id<'csmBookingAttempts'>,
	seedUid?: string,
	seen = new Set<string>()
) {
	const snapshot: Recovery = await ctx.runMutation(internal.csmBookings.beginRecovery, {
		attemptId
	});
	if (!snapshot || snapshot.attempt.state === 'booked') return;
	const { attempt: a, proof } = snapshot;
	if (!a.attendeeEmail) return;
	const reference = attemptReference(a);
	const records = new Map<string, unknown>();
	const signed = (raw: unknown) =>
		object(raw) && object(raw.metadata) && raw.metadata.dinuCsmAttempt === reference;
	const reserve = (uid: string) => {
		if (!validBookingUid(uid) || (!seen.has(uid) && seen.size >= 9)) return false;
		seen.add(uid);
		return true;
	};
	const fetchUid = async (uid: string) => {
		if (!reserve(uid)) return false;
		// Even attribution facts read before beginRecovery are refetched; only this pass can release.
		const raw = await calRead(ctx, `bookings/${encodeURIComponent(uid)}`, '2026-02-25');
		if (!object(raw) || raw.uid !== uid) return false;
		records.set(uid, raw);
		return true;
	};
	const locators = seedUid
		? [seedUid]
		: a.providerUid
			? [a.providerUid]
			: (a.lineage ?? []).map((b) => b.uid);
	if (locators.length) {
		if (locators.length > 9) return;
		for (const uid of new Set(locators)) if (!(await fetchUid(uid))) return;
	} else {
		let cursor: string | undefined;
		for (let page = 0; page < 3; page++) {
			const q = new URLSearchParams({
				attendeeEmail: a.attendeeEmail,
				eventTypeId: String(EVENT_ID),
				afterStart: new Date(Date.parse(a.requestedStart) - 1000).toISOString(),
				beforeEnd: new Date(Date.parse(a.requestedStart) + 86_400_000).toISOString(),
				limit: '100'
			});
			if (cursor) q.set('cursor', cursor);
			const response = await calRequest(ctx, `bookings?${q}`, '2026-05-01');
			const body = response.body;
			if (
				!response.ok ||
				!object(body) ||
				body.status !== 'success' ||
				!Array.isArray(body.data) ||
				!object(body.pagination) ||
				body.data.length > 100
			)
				return;
			for (const raw of body.data)
				if (signed(raw)) {
					if (!object(raw) || !validBookingUid(raw.uid) || !reserve(raw.uid)) return;
					records.set(raw.uid, raw);
				}
			if (body.pagination.hasMore === false) break;
			if (page === 2 || !validBookingUid(body.pagination.nextCursor)) return;
			cursor = body.pagination.nextCursor;
		}
	}
	if (!records.size) return;
	const bookings = new Map<string, ProviderBooking>();
	let anchorUid: string | undefined;
	// Map iteration includes newly appended neighbors; every unique node is processed once.
	for (const [uid, raw] of records) {
		const b = parseBooking(raw, a.attendeeEmail);
		if (!b || b.uid !== uid) return;
		if (
			object(raw) &&
			object(raw.metadata) &&
			raw.metadata.dinuCsmAttempt !== undefined &&
			!signed(raw)
		)
			return;
		if (signed(raw)) anchorUid = uid;
		bookings.set(uid, b);
		for (const neighbor of [b.fromUid, b.toUid])
			if (neighbor && !records.has(neighbor) && !(await fetchUid(neighbor))) return;
	}
	if (!anchorUid || bookings.size !== records.size) return;
	const rows = [...bookings.values()];
	const roots = rows.filter((b) => !b.fromUid);
	if (roots.length !== 1 || roots[0].start !== a.requestedStart) return;
	let leaf = roots[0];
	const visited = new Set<string>();
	while (true) {
		if (visited.has(leaf.uid)) return;
		visited.add(leaf.uid);
		const children = rows.filter((b) => b.fromUid === leaf.uid || leaf.toUid === b.uid);
		if (children.length > 1) return;
		if (!children.length) {
			if (leaf.toUid) return;
			break;
		}
		const child = children[0];
		if ((child.fromUid && child.fromUid !== leaf.uid) || (leaf.toUid && leaf.toUid !== child.uid))
			return;
		leaf = child;
	}
	if (visited.size !== rows.length) return;
	await ctx.runMutation(internal.csmBookings.settleCreation, {
		attemptId,
		reference,
		attendeeEmail: a.attendeeEmail,
		anchorUid,
		booking: leaf,
		source: 'recovery',
		...(proof ? { proof } : {})
	});
}
export const checkStatus = action({
	args: { ...memberArgs, ...attemptArgs },
	returns: v.null(),
	handler: async (ctx, args) => {
		const row: Attempt = await ctx.runQuery(internal.csmBookings.readOwned, args);
		if (row.state === 'booked') return null;
		await limiter.limit(ctx, 'status', { key: args.membershipId, throws: true });
		try {
			await reconcile(ctx, args.attemptId);
		} catch {
			throw new ConvexError('Booking status could not be checked. Please try again shortly.');
		}
		return null;
	}
});
/** Shared source state contains no other admin's receipt, operation or attendee data. */
export const replacementStatus = query({
	args: { ...memberArgs, replacement: setupReplacement },
	returns: replacementProgress,
	handler: async (ctx, a) =>
		sharedReplacement(ctx, await requireMembership(ctx, a.membershipId), a.replacement)
});
export const replacementRecovery = internalQuery({
	args: { ...memberArgs, replacement: setupReplacement },
	returns: v.union(v.id('csmBookingAttempts'), v.null()),
	handler: async (ctx, a) => {
		const owner = await requireMembership(ctx, a.membershipId);
		const source = await replacementSource(ctx, owner, a.replacement);
		const progress = await replacementState(ctx, source);
		return 'attempt' in progress &&
			progress.attempt &&
			(source.currentUid === a.replacement.currentUid ||
				sameReplacement(progress.attempt.replacement, a.replacement)) &&
			(progress.state === 'uncertain' || progress.state === 'in-progress')
			? progress.attempt._id
			: null;
	}
});
export const checkReplacement = action({
	args: { ...memberArgs, replacement: setupReplacement },
	returns: v.null(),
	handler: async (ctx, a) => {
		const attemptId: Id<'csmBookingAttempts'> | null = await ctx.runQuery(
			internal.csmBookings.replacementRecovery,
			a
		);
		await limiter.limit(ctx, 'status', { key: a.replacement.appointmentId, throws: true });
		if (attemptId) {
			try {
				await reconcile(ctx, attemptId);
			} catch {
				throw new ConvexError('Booking status could not be checked. Please try again shortly.');
			}
		}
		return null;
	}
});
/** Operator positive recovery verifies a signed accepted record directly, even beyond the chain cap. */
export const resolveConfirmed = internalAction({
	args: { ...attemptArgs, ...operatorEvidence, uid: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const snapshot: Recovery = await ctx.runMutation(internal.csmBookings.beginRecovery, {
			attemptId: args.attemptId
		});
		if (
			!snapshot ||
			snapshot.attempt.state !== 'unknown' ||
			!snapshot.proof ||
			snapshot.attempt.revision !== args.expectedRevision ||
			!validBookingUid(args.uid) ||
			!validOperator(args)
		)
			throw new ConvexError('Inspect the current attempt and terminal sender before confirming.');
		const a = snapshot.attempt;
		const raw = await calRead(ctx, `bookings/${encodeURIComponent(args.uid)}`, '2026-02-25');
		const b = a.attendeeEmail ? parseBooking(raw, a.attendeeEmail) : null;
		if (
			!b ||
			b.uid !== args.uid ||
			b.status !== 'accepted' ||
			!object(raw) ||
			!object(raw.metadata) ||
			raw.metadata.dinuCsmAttempt !== attemptReference(a) ||
			(!b.fromUid && b.start !== a.requestedStart)
		)
			throw new ConvexError(
				'Cal did not verify an accepted booking with this exact attempt association.'
			);
		await ctx.runMutation(internal.csmBookings.settleCreation, {
			attemptId: a._id,
			reference: raw.metadata.dinuCsmAttempt,
			attendeeEmail: a.attendeeEmail!,
			anchorUid: b.uid,
			booking: b,
			source: 'operator',
			operatorEvidence: {
				expectedRevision: args.expectedRevision,
				operator: args.operator,
				evidence: args.evidence,
				reason: args.reason
			}
		});
		return null;
	}
});
/** Old operator arrays remain recovery hints. Text alone cannot establish a positive confirmation. */
export const resolveUnknown = internalMutation({
	args: {
		...attemptArgs,
		...operatorEvidence,
		proof: v.optional(terminalProof),
		resolution: v.union(
			v.object({ kind: v.literal('booking'), bookings: v.array(providerBooking) }),
			v.object({ kind: v.literal('notCreated'), basis: v.literal('providerInvestigation') })
		)
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const a = await ctx.db.get('csmBookingAttempts', args.attemptId);
		if (
			!a ||
			a.state !== 'unknown' ||
			a.revision !== args.expectedRevision ||
			!(await liveAttempt(ctx, a))
		)
			throw new ConvexError('The attempt changed; inspect it again.');
		if (!a.senderTerminal || !validOperator(args))
			throw new ConvexError('Terminal execution and authoritative evidence are required.');
		if (args.resolution.kind === 'booking') {
			const hints = args.resolution.bookings;
			if (!hints.length || hints.length > 9 || hints.some((b) => !validBookingUid(b.uid)))
				throw new ConvexError('Supply bounded booking locators for authenticated recovery.');
			await ctx.scheduler.runAfter(0, internal.csmBookings.recoverWebhook, {
				reference: attemptReference(a),
				uid: hints[0].uid
			});
		} else {
			if (!sameProof(a, args.proof))
				throw new ConvexError(
					'Observe the sender before investigating noncreation, then supply that terminal proof.'
				);
			await patch(ctx, a, {
				state: 'failed',
				error: 'interrupted',
				failureBasis: 'providerInvestigation',
				lineage: undefined,
				reviewRequired: undefined
			});
		}
		await ctx.db.patch('csmBookingAttempts', a._id, {
			operatorResolution: {
				operator: args.operator,
				evidence: args.evidence,
				reason: args.reason,
				at: Date.now()
			}
		});
		return null;
	}
});
/** Bounded, explicitly invoked transition. Never schedules a sender or changes operation identity. */
export const maintainReceipts = internalMutation({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: v.object({
		cursor: v.string(),
		isDone: v.boolean(),
		scanned: v.number(),
		changed: v.number(),
		blocked: v.number()
	}),
	handler: async (ctx, { cursor }) => {
		const page = await ctx.db
			.query('csmBookingAttempts')
			.withIndex('by_creation_time')
			.paginate({ cursor, numItems: 25 });
		let changed = 0,
			blocked = 0;
		for (const original of page.page) {
			await observeSender(ctx, original);
			const a = (await ctx.db.get('csmBookingAttempts', original._id))!;
			const fields: Partial<Infer<typeof import('./csmBookingValidators').storedCsmAttempt>> = {};
			if (a.state === 'failed' && !a.failureBasis) {
				fields.state = 'unknown';
				fields.error = 'uncertain';
			}
			if (a.state === 'booked' && !a.confirmation) {
				const b = a.lineage?.find((b) => b.uid === a.providerUid);
				if (
					b?.status === 'accepted' &&
					!b.toUid &&
					validBookingUid(b.uid) &&
					iso(b.start) === b.start &&
					iso(b.end) === b.end &&
					b.end > b.start
				) {
					fields.confirmation = {
						uid: b.uid,
						start: b.start,
						end: b.end,
						confirmedAt: a.updatedAt
					};
				} else blocked++;
			}
			if (a.confirmation || fields.confirmation) fields.providerUid = undefined;
			if (a.confirmation || fields.confirmation || (a.state === 'failed' && a.failureBasis)) {
				fields.lineage = undefined;
				fields.reviewRequired = undefined;
				if (a.operatorResolution?.priorLineage)
					fields.operatorResolution = {
						operator: a.operatorResolution.operator,
						evidence: a.operatorResolution.evidence,
						reason: a.operatorResolution.reason,
						at: a.operatorResolution.at
					};
			}
			if (a.senderTerminal && (a.confirmation || fields.confirmation))
				fields.attendeeEmail = undefined;
			const semantic = fields.state !== undefined || fields.confirmation !== undefined;
			if (Object.entries(fields).some(([k, value]) => a[k as keyof Attempt] !== value)) {
				if (semantic) await patch(ctx, a, fields);
				else await ctx.db.patch('csmBookingAttempts', a._id, fields);
			}
			// R-09: independent constant-field cleanup, never changes lifecycle revision.
			if (a.eventTypeId !== undefined)
				await ctx.db.patch('csmBookingAttempts', a._id, { eventTypeId: undefined });
			await seedSetupAppointment(ctx, (await ctx.db.get('csmBookingAttempts', a._id))!);
			if (
				JSON.stringify(original) !== JSON.stringify(await ctx.db.get('csmBookingAttempts', a._id))
			)
				changed++;
		}
		return {
			cursor: page.continueCursor,
			isDone: page.isDone,
			scanned: page.page.length,
			changed,
			blocked
		};
	}
});
export const markSetupBooked = internalMutation({
	args: { companyReference: v.string() },
	returns: v.null(),
	handler: async (ctx, { companyReference }) => {
		const id = ctx.db.normalizeId('company', companyReference);
		const company = id ? await availableCompany(ctx, id) : null;
		if (company && company.csmCallBookedAt === undefined)
			await ctx.db.patch('company', company._id, { csmCallBookedAt: Date.now() });
		return null;
	}
});
export const readReference = internalQuery({
	args: { reference: v.string() },
	returns: v.union(schema.doc('csmBookingAttempts'), v.null()),
	handler: async (ctx, { reference }) => {
		const parts = reference.split('.');
		const id = parts.length === 2 ? ctx.db.normalizeId('csmBookingAttempts', parts[0]) : null;
		const a = id ? await ctx.db.get('csmBookingAttempts', id) : null;
		return a && reference === attemptReference(a) && (await liveAttempt(ctx, a)) ? a : null;
	}
});
function referencedAttempt(ctx: ActionCtx, reference: string): Promise<Attempt | null> {
	return ctx.runQuery(internal.csmBookings.readReference, { reference });
}
/** Missing webhook metadata is recovered through authenticated API facts, never email attribution. */
export const recoverWebhook = internalAction({
	args: {
		reference: v.optional(v.string()),
		uid: v.string(),
		previousUid: v.optional(v.string()),
		successorHint: v.optional(v.string())
	},
	returns: v.null(),
	handler: async (ctx, { reference, uid, previousUid, successorHint }) => {
		if (!validBookingUid(uid)) return null;
		if (reference !== undefined) {
			const a = await referencedAttempt(ctx, reference);
			if (a?.state === 'booked')
				await ctx.runMutation(internal.csmSetupAppointments.notify, {
					uid,
					attemptId: a._id,
					previousUid,
					successorHint
				});
			else if (a) await reconcile(ctx, a._id, uid);
			return null;
		}
		if (
			await ctx.runMutation(internal.csmSetupAppointments.notify, {
				uid,
				previousUid,
				successorHint
			})
		)
			return null;
		const records = new Map<string, unknown>([[uid, undefined]]);
		for (const [key] of records) {
			const raw = await calRead(ctx, `bookings/${encodeURIComponent(key)}`, '2026-02-25');
			if (!object(raw) || raw.uid !== key || raw.eventTypeId !== EVENT_ID) return null;
			const metadata = object(raw.metadata) ? raw.metadata : {};
			if (metadata.dinuCsmAttempt !== undefined) {
				if (typeof metadata.dinuCsmAttempt !== 'string') return null;
				const a = await referencedAttempt(ctx, metadata.dinuCsmAttempt);
				if (!a) return null; // Purported native references never fall through into legacy promotion.
				if (a.state === 'booked') {
					await ctx.runMutation(internal.csmSetupAppointments.notify, {
						uid,
						attemptId: a._id,
						previousUid,
						successorHint
					});
					return null;
				}
				if (!a.attendeeEmail || !parseBooking(raw, a.attendeeEmail)) return null;
				await reconcile(ctx, a._id, uid, new Set(records.keys()));
				return null;
			}
			if (typeof metadata.dinuCsmReference === 'string') {
				await ctx.runAction(internal.csmSetupAppointments.legacyWebhook, {
					reference: metadata.dinuCsmReference,
					uid: key,
					previousUid,
					successorHint
				});
				return null;
			}
			// Known old/intermediate UIDs can attribute a later metadata-less delivery.
			if (await ctx.runMutation(internal.csmSetupAppointments.notify, { uid: key, successorHint }))
				return null;
			// Attribution only follows authenticated explicit links. No facts from this pass settle.
			const b = parseSetupBooking(raw, key);
			if (!b) return null;
			for (const neighbor of [b.fromUid, b.toUid])
				if (neighbor && !records.has(neighbor)) {
					if (records.size >= 9) return null;
					records.set(neighbor, undefined);
				}
		}
		return null;
	}
});
export const webhook = httpAction(async (ctx, request): Promise<Response> => {
	const secret = env.CAL_WEBHOOK_SECRET;
	if (!secret) return new Response('Webhook is not configured', { status: 503 });
	const max = 256 * 1024;
	if (Number(request.headers.get('content-length')) > max)
		return new Response('Webhook payload too large', { status: 413 });
	const reader = request.body?.getReader();
	if (!reader) return new Response('Invalid event', { status: 400 });
	const body = await readTextBody(reader, max);
	if (body === null) return new Response('Webhook payload too large', { status: 413 });
	if (!(await verifySignature(secret, body, request.headers.get('x-cal-signature-256') ?? '')))
		return new Response('Invalid signature', { status: 400 });
	let event: unknown;
	try {
		event = JSON.parse(body);
	} catch {
		return new Response('Invalid event', { status: 400 });
	}
	if (!object(event) || typeof event.triggerEvent !== 'string')
		return new Response('Invalid event', { status: 400 });
	if (
		![
			'BOOKING_CREATED',
			'BOOKING_REQUESTED',
			'BOOKING_RESCHEDULED',
			'BOOKING_CANCELLED',
			'BOOKING_REJECTED'
		].includes(event.triggerEvent)
	)
		return new Response(null, { status: 204 });
	const p = event.payload;
	if (!object(p) || !validBookingUid(p.uid))
		return new Response('Invalid booking', { status: 400 });
	if (
		p.type !== EVENT_SLUG ||
		!object(p.organizer) ||
		p.organizer.username !== HOST ||
		(p.eventTypeId !== undefined && p.eventTypeId !== EVENT_ID)
	)
		return new Response(null, { status: 204 });
	const metadata = object(p.metadata) ? p.metadata : {};
	const rescheduled = event.triggerEvent === 'BOOKING_RESCHEDULED';
	const hints = {
		...(rescheduled && validBookingUid(p.rescheduleUid) ? { previousUid: p.rescheduleUid } : {}),
		...(rescheduled ? { successorHint: p.uid } : {})
	};
	// Presence of a native hint, even malformed, must never fall back to company promotion.
	if (metadata.dinuCsmAttempt !== undefined && typeof metadata.dinuCsmAttempt !== 'string')
		return new Response('Invalid booking reference', { status: 400 });
	if (
		typeof metadata.dinuCsmAttempt === 'string' ||
		typeof metadata.dinuCsmReference !== 'string'
	) {
		try {
			await ctx.runAction(internal.csmBookings.recoverWebhook, {
				uid: p.uid,
				...hints,
				...(typeof metadata.dinuCsmAttempt === 'string'
					? { reference: metadata.dinuCsmAttempt }
					: {})
			});
		} catch {
			return new Response('Booking recovery is unavailable', { status: 503 });
		}
	} else {
		const reference = await parseCompanyReference(metadata.dinuCsmReference);
		if (!reference) return new Response('Invalid booking reference', { status: 400 });
		if (
			reference.mode === 'setup' &&
			['BOOKING_CREATED', 'BOOKING_REQUESTED', 'BOOKING_RESCHEDULED'].includes(event.triggerEvent)
		)
			await ctx.runMutation(internal.csmBookings.markSetupBooked, {
				companyReference: reference.companyId
			});
		if (reference.mode === 'setup') {
			try {
				await ctx.runAction(internal.csmSetupAppointments.legacyWebhook, {
					reference: metadata.dinuCsmReference,
					uid: p.uid,
					...hints
				});
			} catch {
				return new Response('Booking synchronization is unavailable', { status: 503 });
			}
		}
	}
	return new Response(null, { status: 204 });
});

/** Read-only operator preflight; never creates a booking or returns organizer/attendee data. */
export const providerStatus = internalAction({
	args: {},
	returns: v.object({
		available: v.boolean(),
		duration: v.number(),
		videoProvider: v.union(v.string(), v.null()),
		slotCount: v.number()
	}),
	handler: async (ctx) => {
		const config = await configuration(ctx);
		if (!config) return { available: false, duration: 0, videoProvider: null, slotCount: 0 };
		const now = Date.now();
		const times = await slots(
			ctx,
			new Date(now).toISOString(),
			new Date(now + 8 * 86_400_000).toISOString(),
			'UTC',
			config.duration
		);
		return {
			available: true,
			duration: config.duration,
			videoProvider: config.location.integration,
			slotCount: times.length
		};
	}
});
