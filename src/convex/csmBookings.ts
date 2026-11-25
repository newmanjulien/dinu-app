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
	membershipForProfile,
	requireAccount,
	requirePermission,
	verifiedIdentity,
	type CompanyAccess
} from './auth';
import { readTextBody } from '../lib/http-body';
import { BOOKING_WINDOW_MS, withinBookingWindow } from '../lib/booking-window';
import schema from './schema';
import { canonicalState, confirmedEvidence, validOperator } from './csmAttemptState';
import { assertHistoricalAdmission } from './csmHistory';
import { retireSupersededSetupAppointment } from './csmSetupLifecycle';
import { permissionsForRole } from './permissions';
import { pendingInitialSetup, resolveSetupBooking } from './csmSetupState';
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
	isSenderExecutionTerminal,
	terminalProof
} from './csmBookingValidators';
import { setupReplacement, meetingPolicy } from './csmBookingValidators';
import { seedMeetingPreparation } from './csmMeetingPreparation';
import {
	object,
	iso,
	validTimeZone,
	validBookingUid,
	configuration,
	slots,
	calRead,
	calRequest,
	parseBooking,
	parseSetupLocator,
	noncreatingRejection,
	bookingInScope,
	type ProviderBooking,
	type BookingMode
} from './csmCal';
import { attemptReference, historicalAttemptLocators, historicalAttemptStart } from './csmHistory';
import {
	creationScope,
	frozenAttemptReference,
	newAttemptReference,
	newDispatchId,
	attemptIdFromReference,
	verifySignature
} from './csmIdentity';

import { blockingInitialGuard } from './csmErasureGuards';
import {
	enrollAttemptRecovery,
	recoveryDisposition,
	RECOVERY_LEASE,
	EVIDENCE_PASSES,
	evidenceRetry,
	readFailure
} from './csmRecoveryPolicy';

type Attempt = Doc<'csmBookingAttempts'>;
const attemptArgs = { attemptId: v.id('csmBookingAttempts') };
const memberArgs = { membershipId: v.id('memberships') };
const operatorEvidence = {
	expectedRevision: v.number(),
	operator: v.string(),
	evidence: v.string(),
	reason: v.string()
};
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
		start: a.confirmation?.start ?? historicalAttemptStart(a) ?? a.requestedStart,
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
async function assertAccess(
	ctx: QueryCtx,
	a: CompanyAccess,
	mode: BookingMode,
	replacement?: Replacement
) {
	if (mode !== 'setup') {
		if (replacement) throw new ConvexError('This setup call is unavailable.');
		if (!a.company.templateSourceId)
			throw new ConvexError('Support booking is available once your template is ready.');
		return;
	}
	if (a.company.templateSourceId)
		throw new ConvexError('Your contract template is already set up.');
	const booking = await resolveSetupBooking(ctx, a.company);
	if (booking.kind === 'initial' && !replacement) {
		if (
			(await pendingInitialSetup(ctx, a.companyId)) ||
			(await blockingInitialGuard(ctx, a.companyId))
		)
			throw new ConvexError('A setup call is still being confirmed. Please check its status.');
		return;
	}
	if (booking.kind === 'cancelled' && replacement) {
		const source = await replacementSource(ctx, a, replacement);
		if ((await replacementState(ctx, source)).state === 'ready') return;
		throw new ConvexError('This setup call is being updated. Please check its status.');
	}
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
		permissionsForRole(member.role).manageTemplate;
	if (!memberEligible || !company) return false;
	if (a.mode !== 'setup') return !a.replacement && Boolean(company.templateSourceId);
	if (company.templateSourceId) return false;
	const booking = await resolveSetupBooking(ctx, company);
	if (!a.replacement)
		return (
			booking.kind === 'initial' &&
			!(await pendingInitialSetup(ctx, a.companyId, a._id)) &&
			!(await blockingInitialGuard(ctx, a.companyId))
		);
	const source = booking.kind === 'cancelled' ? booking.appointment : null;
	return (
		!!source &&
		source._id === a.replacement.appointmentId &&
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
	a ??= await requirePermission(ctx, 'manageTemplate', membershipId);
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
		const owner = await requirePermission(ctx, 'manageTemplate', a.membershipId);
		await assertAccess(ctx, owner, a.mode, a.replacement);
		return null;
	}
});
export const authorizeOnboardingAvailability = internalQuery({
	args: {},
	returns: v.id('profiles'),
	handler: async (ctx) => {
		const { profile } = await requireAccount(ctx);
		if (await membershipForProfile(ctx, profile._id))
			throw new ConvexError('Your company access has changed. Reload to continue.');
		return profile._id;
	}
});
async function readAvailability(
	ctx: ActionCtx,
	timeZone: string
): Promise<Infer<typeof availabilityResult>> {
	const now = Date.now();
	if (!creationScope()) return { status: 'unavailable', slots: [], duration: 0 };
	// Attach both handlers immediately; invalid configuration must not wait for slots.
	const configRead = configuration(ctx);
	const slotRead = slots(
		ctx,
		new Date(now).toISOString(),
		new Date(now + BOOKING_WINDOW_MS).toISOString(),
		timeZone
	).then(
		(value) => ({ value }),
		(error: unknown) => ({ error })
	);
	const config = await configRead;
	if (!config) return { status: 'unavailable', slots: [], duration: 0 };
	const outcome = await slotRead;
	if ('error' in outcome) throw outcome.error;
	const result = outcome.value;
	if (result.some((s) => Date.parse(s.end) - Date.parse(s.start) !== config.duration * 60_000))
		throw new ConvexError('Invalid calendar duration.');
	return {
		status: 'ready',
		duration: config.duration,
		slots: result.filter((s) => withinBookingWindow(s.start, now))
	};
}
export const onboardingAvailability = action({
	args: { timeZone: v.string() },
	returns: availabilityResult,
	handler: async (ctx, { timeZone }): Promise<Infer<typeof availabilityResult>> => {
		const profileId = await ctx.runQuery(internal.csmBookings.authorizeOnboardingAvailability, {});
		if (!validTimeZone(timeZone)) throw new ConvexError('Invalid time zone.');
		await limiter.limit(ctx, 'calendar', { key: profileId, throws: true });
		return readAvailability(ctx, timeZone);
	}
});
export const availability = action({
	args: {
		...memberArgs,
		mode: bookingMode,
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
		if (!validTimeZone(a.timeZone)) throw new ConvexError('Invalid time zone.');
		await limiter.limit(ctx, 'calendar', { key: a.membershipId, throws: true });
		return readAvailability(ctx, a.timeZone);
	}
});
export const attempt = query({
	args: {
		...memberArgs,
		mode: bookingMode,
		attemptId: v.optional(v.id('csmBookingAttempts')),
		replacement: v.optional(setupReplacement)
	},
	returns: v.union(attemptView, v.null()),
	handler: async (ctx, a) => {
		const owner = await requirePermission(ctx, 'manageTemplate', a.membershipId);
		const row = a.attemptId
			? await owned(ctx, a.membershipId, a.attemptId, owner)
			: await pending(ctx, a.membershipId);
		if (row && (row.mode !== a.mode || !sameReplacement(row.replacement, a.replacement)))
			return null;
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
		replacement: v.optional(setupReplacement)
	},
	returns: bookingAck,
	handler: async (ctx, a): Promise<Infer<typeof bookingAck>> => {
		const owner = await requirePermission(ctx, 'manageTemplate', a.membershipId);
		const acknowledge = (row: Attempt) => ({ attemptId: row._id, operationId: row.operationId });
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
				prior.companyId !== owner.companyId ||
				prior.profileId !== owner.profile._id ||
				prior.mode !== a.mode ||
				prior.requestedStart !== a.start ||
				prior.timeZone !== a.timeZone ||
				!sameReplacement(prior.replacement, a.replacement)
			)
				throw new ConvexError(
					'This booking operation has changed. Close this window and try again.'
				);
			return acknowledge(prior);
		}
		const unresolved = await pending(ctx, a.membershipId);
		if (unresolved) {
			if (
				unresolved.companyId !== owner.companyId ||
				unresolved.profileId !== owner.profile._id ||
				unresolved.mode !== a.mode ||
				!sameReplacement(unresolved.replacement, a.replacement)
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
			!withinBookingWindow(start, Date.now()) ||
			!validTimeZone(a.timeZone)
		)
			throw new ConvexError('Choose an available time.');
		await assertHistoricalAdmission(ctx, a.membershipId);
		await assertAccess(ctx, owner, a.mode, a.replacement);
		const providerScope = creationScope();
		if (!providerScope) throw new ConvexError('Booking is temporarily unavailable.');
		await limiter.limit(ctx, 'book', { key: a.membershipId, throws: true });
		if (a.replacement)
			await limiter.limit(ctx, 'book', { key: a.replacement.appointmentId, throws: true });
		const identity = await verifiedIdentity(ctx);
		const email = identity.email.trim().toLowerCase();
		const name = owner.profile.name.trim() || email;
		const id = await ctx.db.insert('csmBookingAttempts', {
			format: 2,
			companyId: owner.companyId,
			profileId: owner.profile._id,
			membershipId: a.membershipId,
			mode: a.mode,
			...(a.replacement ? { replacement: a.replacement } : {}),
			operationId: a.operationId,
			providerScope,
			dispatchId: newDispatchId(),
			requestedStart: start,
			timeZone: a.timeZone,
			attendeeName: name.slice(0, 200),
			attendeeEmail: email,
			state: 'queued',
			revision: 0,
			updatedAt: Date.now()
		});
		const inserted = (await ctx.db.get('csmBookingAttempts', id))!;
		await ctx.db.patch('csmBookingAttempts', id, {
			attemptReference: newAttemptReference(inserted)
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
			? a
			: null;
	}
});
export const readOwned = internalQuery({
	args: { ...memberArgs, ...attemptArgs },
	returns: schema.doc('csmBookingAttempts'),
	handler: (ctx, a) => owned(ctx, a.membershipId, a.attemptId)
});
export async function patchAttempt(
	ctx: MutationCtx,
	a: Attempt,
	fields: Partial<Infer<typeof import('./csmBookingValidators').storedCsmAttempt>>
) {
	await ctx.db.patch('csmBookingAttempts', a._id, {
		...fields,
		...canonicalState({ ...a, ...fields }),
		revision: a.revision + 1,
		updatedAt: Date.now()
	});
	const updated = (await ctx.db.get('csmBookingAttempts', a._id))!;
	if (updated.state === 'unknown') {
		if (updated.recoveryDue === undefined) await enrollAttemptRecovery(ctx, updated);
	} else if (updated.recoveryDue !== undefined || updated.recoveryLeaseUntil !== undefined)
		await ctx.db.patch('csmBookingAttempts', a._id, {
			recoveryDue: undefined,
			recoveryLeaseUntil: undefined
		});
}

export const claim = internalMutation({
	args: {
		...attemptArgs,
		replacementProof: v.optional(setupProof),
		meetingPolicy: v.optional(meetingPolicy)
	},
	returns: v.boolean(),
	handler: async (ctx, { attemptId, replacementProof, meetingPolicy }) => {
		const a = await ctx.db.get('csmBookingAttempts', attemptId);
		if (!a || a.state !== 'queued') return false;
		if (
			!(await stillEligible(ctx, a)) ||
			Date.now() > a._creationTime + 45_000 ||
			!a.attendeeName ||
			!a.attendeeEmail ||
			!a.providerScope ||
			!a.dispatchId ||
			!frozenAttemptReference(a)
		) {
			await patchAttempt(ctx, a, {
				state: 'failed',
				error: 'access',
				failureBasis: 'queuedPreflight'
			});
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
				proof.lease !== source.lease
			) {
				await patchAttempt(ctx, a, {
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
				proof.result.kind !== 'success' ||
				!committed ||
				committed.dirty ||
				committed.generation !== proof.generation ||
				committed.providerUpdatedAt !== proof.result.booking.updatedAt ||
				!(await stillEligible(ctx, a))
			) {
				await patchAttempt(ctx, a, {
					state: 'failed',
					error: 'access',
					failureBasis: 'queuedPreflight'
				});
				return false;
			}
		}
		await patchAttempt(ctx, a, { state: 'submitting', meetingPolicy });
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
		await patchAttempt(ctx, a, {
			state: safe ? 'failed' : 'unknown',
			error,
			failureBasis: safe ? (basis ?? 'queuedPreflight') : undefined
		});
		return null;
	}
});
export async function observeSender(ctx: MutationCtx, a: Attempt) {
	let terminal = isSenderExecutionTerminal(a.senderTerminal?.kind) ? a.senderTerminal : undefined;
	if (!terminal && a.sendJobId) {
		const job = await ctx.db.system.get('_scheduled_functions', a.sendJobId);
		if (job && isSenderExecutionTerminal(job.state.kind))
			terminal = { kind: job.state.kind, observedAt: Date.now() };
	}
	if (terminal)
		await ctx.db.patch('csmBookingAttempts', a._id, {
			senderTerminal: terminal,
			attendeeName: undefined,
			...(a.state === 'booked' && confirmedEvidence(a) ? { attendeeEmail: undefined } : {})
		});
	return terminal;
}
function proofFor(a: Attempt): Infer<typeof terminalProof> | undefined {
	return a.sendJobId && a.senderTerminal && isSenderExecutionTerminal(a.senderTerminal.kind)
		? { attemptId: a._id, sendJobId: a.sendJobId, ...a.senderTerminal }
		: undefined;
}
async function liveAttempt(ctx: QueryCtx, a: Attempt) {
	return !!(await liveProfile(ctx, a.profileId)) && !!(await availableCompany(ctx, a.companyId));
}
const recoverySnapshot = v.union(
	v.object({
		attempt: schema.doc('csmBookingAttempts'),
		proof: v.optional(terminalProof),
		lease: v.optional(v.number()),
		generation: v.optional(v.number()),
		evidenceIds: v.optional(v.array(v.id('csmWebhookEvidence'))),
		evidenceUids: v.optional(v.array(v.string()))
	}),
	v.null()
);
type Recovery = Infer<typeof recoverySnapshot>;
/** Observe execution before any provider facts that might release the unresolved guard. */
export const beginRecovery = internalMutation({
	args: { ...attemptArgs, claim: v.optional(v.boolean()) },
	returns: recoverySnapshot,
	handler: async (ctx, { attemptId, claim }): Promise<Recovery> => {
		const a = await ctx.db.get('csmBookingAttempts', attemptId);
		if (!a || !(await liveAttempt(ctx, a))) return null;
		await observeSender(ctx, a);
		let updated = (await ctx.db.get('csmBookingAttempts', attemptId))!;
		if (claim) {
			if (updated.state === 'booked' || (updated.state === 'failed' && !updated.recoverySeedUid))
				return null;
			if (updated.state === 'unknown' && updated.recoveryDue === undefined)
				await enrollAttemptRecovery(ctx, updated);
			updated = (await ctx.db.get('csmBookingAttempts', attemptId))!;
			if (
				updated.recoveryReview ||
				updated.reviewRequired ||
				(updated.recoveryDue ?? Infinity) > Date.now() ||
				(updated.recoveryLeaseUntil ?? 0) > Date.now()
			)
				return null;
			const obligations = await ctx.db
				.query('csmWebhookEvidence')
				.withIndex('by_attemptId_and_state', (q) =>
					q.eq('attemptId', attemptId).eq('state', 'retained')
				)
				.take(26);
			const evidenceUids = [
				...new Set(
					obligations.flatMap((row) =>
						row.hint
							? [row.hint.uid, row.hint.previousUid, row.hint.successorHint].filter(
									(uid): uid is string => uid !== undefined
								)
							: []
					)
				)
			];
			if (obligations.length > 25 || evidenceUids.length > 9) {
				await ctx.db.patch('csmBookingAttempts', attemptId, {
					recoveryReview: 'evidenceCap',
					recoveryDue: undefined
				});
				return null;
			}
			const lease = (updated.recoveryLease ?? 0) + 1;
			await ctx.db.patch('csmBookingAttempts', attemptId, {
				recoveryLease: lease,
				recoveryLeaseUntil: Date.now() + RECOVERY_LEASE,
				recoveryDue: Date.now() + RECOVERY_LEASE
			});
			return {
				attempt: updated,
				proof: proofFor(updated),
				lease,
				generation: updated.recoveryGeneration ?? 0,
				evidenceIds: obligations.map((row) => row._id),
				evidenceUids
			};
		}
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
		proof: v.optional(terminalProof),
		recoveryLease: v.optional(v.number()),
		recoveryGeneration: v.optional(v.number()),
		evidenceIds: v.optional(v.array(v.id('csmWebhookEvidence'))),
		proofUids: v.optional(v.array(v.string()))
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const a = await ctx.db.get('csmBookingAttempts', args.attemptId);
		if (
			args.source === 'recovery' &&
			(!a ||
				a.recoveryLease !== args.recoveryLease ||
				(a.recoveryGeneration ?? 0) !== args.recoveryGeneration ||
				(a.recoveryLeaseUntil ?? 0) <= Date.now())
		)
			return null;
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
			!attemptReference(a) ||
			args.reference !== attemptReference(a) ||
			!a.attendeeEmail ||
			args.attendeeEmail !== a.attendeeEmail ||
			!validBookingUid(args.anchorUid)
		)
			return null;
		if (args.source === 'recovery') {
			if (
				!args.evidenceIds ||
				!args.proofUids ||
				args.evidenceIds.length > 25 ||
				args.proofUids.length > 9
			)
				return null;
			for (const id of args.evidenceIds) {
				const row = await ctx.db.get('csmWebhookEvidence', id);
				if (
					!row ||
					row.attemptId !== a._id ||
					row.state !== 'retained' ||
					(row.evidenceGeneration ?? Infinity) > (args.recoveryGeneration ?? -1) ||
					!row.hint ||
					[row.hint.uid, row.hint.previousUid, row.hint.successorHint].some(
						(uid) => uid !== undefined && !args.proofUids!.includes(uid)
					)
				)
					return null;
			}
		}
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
			await patchAttempt(ctx, a, {
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
			await seedSetupAppointment(ctx, (await ctx.db.get('csmBookingAttempts', a._id))!, true);
			await seedMeetingPreparation(ctx, a, b, args.attendeeEmail);
			await ctx.scheduler.runAfter(0, internal.csmEvidence.adoptBookedAttempt, {
				attemptId: a._id
			});
		} else if (a.state !== 'failed') {
			const refused =
				(b.status === 'cancelled' || b.status === 'rejected') && sameProof(a, args.proof);
			await patchAttempt(ctx, a, {
				state: refused ? 'failed' : 'unknown',
				error: refused ? 'cancelled' : 'uncertain',
				failureBasis: refused ? 'providerTerminal' : undefined,
				providerUid: b.uid,
				...(refused ? { recoverySeedUid: undefined } : {}),
				lineage: undefined,
				reviewRequired: undefined
			});
		}
		const settled = await ctx.db.get('csmBookingAttempts', a._id);
		if (args.source === 'recovery' && (settled?.state === 'booked' || settled?.state === 'failed'))
			for (const id of args.evidenceIds ?? []) {
				await ctx.db.patch('csmWebhookEvidence', id, {
					state: 'completed',
					completedAt: Date.now()
				});
			}
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
			await patchAttempt(ctx, a, {
				state: 'failed',
				error: 'interrupted',
				failureBasis: 'queuedExpired'
			});
		else if (a.state === 'submitting')
			await patchAttempt(ctx, a, { state: 'unknown', error: 'uncertain' });
		if (a.state === 'unknown')
			await enrollAttemptRecovery(ctx, (await ctx.db.get('csmBookingAttempts', attemptId))!);
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
			if (
				!a.attendeeEmail ||
				!a.attendeeName ||
				!a.providerScope ||
				!a.dispatchId ||
				!frozenAttemptReference(a)
			)
				throw new Error('Missing immutable identity.');
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
					providerScope: source.providerScope!,
					...(snapshot.reference ? { reference: snapshot.reference } : {}),
					...(source.legacyReference ? { legacyReference: source.legacyReference } : {}),
					evidenceGeneration: snapshot.evidenceGeneration,
					evidenceIds: snapshot.evidenceIds,
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
			const config = await configuration(ctx, a.providerScope);
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
				config.duration,
				a.providerScope
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
			const metadata = { dinuCsmAttempt: frozenAttemptReference(a)! };
			claimStarted = true;
			claimed = await ctx.runMutation(internal.csmBookings.claim, {
				attemptId,
				meetingPolicy: config.meetingPolicy,
				...(replacementProof ? { replacementProof } : {})
			});
			if (!claimed) return null;
			// One app-controlled POST; neither a timeout nor a lost mutation acknowledgement retries it.
			const response = await calRequest(
				ctx,
				'bookings',
				'2026-02-25',
				'POST',
				{
					eventTypeId: a.providerScope.eventTypeId,
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
					? parseBooking(response.body.data, a.attendeeEmail, a.providerScope)
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
	seen = new Set<string>(),
	snapshot: Recovery = null
): Promise<Infer<typeof recoveryDisposition>> {
	if (!snapshot || snapshot.attempt.state === 'booked') return { kind: 'resolved' };
	const { attempt: a, proof } = snapshot;
	if (!a.attendeeEmail) return { kind: 'review', reason: 'missingAttendee' };
	const reference = attemptReference(a);
	if (!reference || !a.providerScope) return { kind: 'review', reason: 'missingOriginalProof' };
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
	const locators = [
		...new Set([
			...(snapshot.evidenceUids ?? []),
			...((seedUid ?? a.recoverySeedUid)
				? [(seedUid ?? a.recoverySeedUid)!]
				: a.providerUid
					? [a.providerUid]
					: historicalAttemptLocators(a))
		])
	];
	if (locators.length) {
		if (locators.length > 9) return { kind: 'retry', reason: 'incompleteEvidence' };
		for (const uid of new Set(locators))
			if (!(await fetchUid(uid))) return { kind: 'retry', reason: 'incompleteEvidence' };
	} else {
		let cursor: string | undefined;
		for (let page = 0; page < 3; page++) {
			const q = new URLSearchParams({
				attendeeEmail: a.attendeeEmail,
				eventTypeId: String(a.providerScope.eventTypeId),
				afterStart: new Date(Date.parse(a.requestedStart) - 1000).toISOString(),
				beforeEnd: new Date(Date.parse(a.requestedStart) + 86_400_000).toISOString(),
				limit: '100'
			});
			if (cursor) q.set('cursor', cursor);
			const response = await calRequest(ctx, `bookings?${q}`, '2026-05-01', 'GET');
			const body = response.body;
			if (
				!response.ok ||
				!object(body) ||
				body.status !== 'success' ||
				!Array.isArray(body.data) ||
				!object(body.pagination) ||
				body.data.length > 100
			)
				return { kind: 'retry', reason: 'incompleteEvidence' };
			for (const raw of body.data)
				if (signed(raw)) {
					if (!object(raw) || !validBookingUid(raw.uid) || !reserve(raw.uid))
						return { kind: 'retry', reason: 'incompleteEvidence' };
					records.set(raw.uid, raw);
				}
			if (body.pagination.hasMore === false) break;
			if (page === 2 || !validBookingUid(body.pagination.nextCursor))
				return { kind: 'retry', reason: 'incompleteEvidence' };
			cursor = body.pagination.nextCursor;
		}
	}
	if (!records.size) return { kind: 'retry', reason: 'incompleteEvidence' };
	const bookings = new Map<string, ProviderBooking>();
	let anchorUid: string | undefined;
	// Map iteration includes newly appended neighbors; every unique node is processed once.
	for (const [uid, raw] of records) {
		const b = parseBooking(raw, a.attendeeEmail, a.providerScope);
		if (!b || b.uid !== uid) return { kind: 'retry', reason: 'incompleteEvidence' };
		if (
			object(raw) &&
			object(raw.metadata) &&
			raw.metadata.dinuCsmAttempt !== undefined &&
			!signed(raw)
		)
			return { kind: 'retry', reason: 'incompleteEvidence' };
		if (signed(raw)) anchorUid = uid;
		bookings.set(uid, b);
		for (const neighbor of [b.fromUid, b.toUid])
			if (neighbor && !records.has(neighbor) && !(await fetchUid(neighbor)))
				return { kind: 'retry', reason: 'incompleteEvidence' };
	}
	if (!anchorUid || bookings.size !== records.size)
		return { kind: 'retry', reason: 'incompleteEvidence' };
	const rows = [...bookings.values()];
	const roots = rows.filter((b) => !b.fromUid);
	if (roots.length !== 1 || roots[0].start !== a.requestedStart)
		return { kind: 'retry', reason: 'incompleteEvidence' };
	let leaf = roots[0];
	const visited = new Set<string>();
	while (true) {
		if (visited.has(leaf.uid)) return { kind: 'retry', reason: 'incompleteEvidence' };
		visited.add(leaf.uid);
		const children = rows.filter((b) => b.fromUid === leaf.uid || leaf.toUid === b.uid);
		if (children.length > 1) return { kind: 'retry', reason: 'incompleteEvidence' };
		if (!children.length) {
			if (leaf.toUid) return { kind: 'retry', reason: 'incompleteEvidence' };
			break;
		}
		const child = children[0];
		if ((child.fromUid && child.fromUid !== leaf.uid) || (leaf.toUid && leaf.toUid !== child.uid))
			return { kind: 'retry', reason: 'incompleteEvidence' };
		leaf = child;
	}
	if (visited.size !== rows.length) return { kind: 'retry', reason: 'incompleteEvidence' };
	await ctx.runMutation(internal.csmBookings.settleCreation, {
		attemptId,
		reference,
		attendeeEmail: a.attendeeEmail,
		anchorUid,
		booking: leaf,
		source: 'recovery',
		recoveryLease: snapshot.lease,
		recoveryGeneration: snapshot.generation,
		evidenceIds: snapshot.evidenceIds ?? [],
		proofUids: [...visited],
		...(proof ? { proof } : {})
	});
	return { kind: 'retry', reason: 'pendingOrChanged' };
}
/** Every trigger shares the same target cooldown, lease and finite history. Evidence alone may wake review once. */
export async function requestAttemptRecovery(
	ctx: MutationCtx,
	a: Attempt,
	seedUid?: string,
	evidence = false
) {
	if (!(await liveAttempt(ctx, a)) || a.state === 'booked') return;
	if (evidence) {
		await ctx.db.patch('csmBookingAttempts', a._id, {
			recoveryGeneration: (a.recoveryGeneration ?? 0) + 1,
			recoverySeedUid: seedUid ?? a.recoverySeedUid,
			recoveryReview: undefined,
			reviewRequired: undefined,
			recoveryDue: Math.max(Date.now(), a.recoveryLeaseUntil ?? 0)
			// Preserve failure history. A failed pass with history >=10 returns immediately to review.
		});
	} else {
		if (a.state === 'unknown') await enrollAttemptRecovery(ctx, a);
	}
	const updated = (await ctx.db.get('csmBookingAttempts', a._id))!;
	if (updated.recoveryReview || updated.reviewRequired || updated.recoveryDue === undefined) return;
	const job = updated.recoveryJobId
		? await ctx.db.system.get('_scheduled_functions', updated.recoveryJobId)
		: null;
	if (evidence && job?.state.kind === 'pending' && job.scheduledTime > updated.recoveryDue) {
		await ctx.scheduler.cancel(job._id);
	} else if (job && ['pending', 'inProgress'].includes(job.state.kind)) return;
	const recoveryJobId = await ctx.scheduler.runAfter(
		Math.max(0, updated.recoveryDue - Date.now()),
		internal.csmBookings.recoverAttempt,
		{ attemptId: a._id }
	);
	await ctx.db.patch('csmBookingAttempts', a._id, { recoveryJobId });
}
export const requestRecovery = internalMutation({
	args: attemptArgs,
	returns: v.null(),
	handler: async (ctx, { attemptId }) => {
		const a = await ctx.db.get('csmBookingAttempts', attemptId);
		if (a) await requestAttemptRecovery(ctx, a);
		return null;
	}
});
export const finishRecovery = internalMutation({
	args: {
		...attemptArgs,
		lease: v.number(),
		generation: v.number(),
		disposition: recoveryDisposition
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const a = await ctx.db.get('csmBookingAttempts', args.attemptId);
		if (!a || !(await liveAttempt(ctx, a)) || a.recoveryLease !== args.lease) return null;
		if (a.state === 'booked' || (a.state === 'failed' && !a.recoverySeedUid)) {
			await ctx.db.patch('csmBookingAttempts', a._id, {
				recoveryDue: undefined,
				recoveryLeaseUntil: undefined,
				recoveryJobId: undefined,
				recoveryReview: undefined
			});
			return null;
		}
		const changed = (a.recoveryGeneration ?? 0) !== args.generation;
		const d = args.disposition;
		const failures = (a.recoveryFailures ?? 0) + (!changed && d.kind === 'retry' ? 1 : 0);
		const review =
			!changed && (d.kind === 'review' || (d.kind === 'retry' && failures >= EVIDENCE_PASSES));
		const due = review
			? undefined
			: changed
				? Date.now()
				: d.kind === 'deferred'
					? d.dueAt
					: evidenceRetry(failures);
		await ctx.db.patch('csmBookingAttempts', a._id, {
			recoveryFailures: failures,
			recoveryLeaseUntil: undefined,
			recoveryJobId: undefined,
			recoveryReview: review ? (d.kind === 'review' ? d.reason : 'evidenceHorizon') : undefined,
			recoveryDue: due
		});
		if (due !== undefined) {
			const recoveryJobId = await ctx.scheduler.runAfter(
				Math.max(0, due - Date.now()),
				internal.csmBookings.recoverAttempt,
				{ attemptId: a._id }
			);
			await ctx.db.patch('csmBookingAttempts', a._id, { recoveryJobId });
		}
		return null;
	}
});
export const recoverAttempt = internalAction({
	args: attemptArgs,
	returns: v.null(),
	handler: async (ctx, { attemptId }) => {
		const snapshot: Recovery = await ctx.runMutation(internal.csmBookings.beginRecovery, {
			attemptId,
			claim: true
		});
		if (!snapshot || snapshot.lease === undefined || snapshot.generation === undefined) return null;
		let disposition: Infer<typeof recoveryDisposition>;
		try {
			disposition = await reconcile(ctx, attemptId, undefined, new Set(), snapshot);
		} catch (error) {
			disposition = readFailure(error);
		}
		await ctx.runMutation(internal.csmBookings.finishRecovery, {
			attemptId,
			lease: snapshot.lease,
			generation: snapshot.generation,
			disposition
		});
		return null;
	}
});
export const repairRecovery = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const due = await ctx.db
			.query('csmBookingAttempts')
			.withIndex('by_recoveryDue', (q) => q.gt('recoveryDue', 0).lte('recoveryDue', Date.now()))
			.take(25);
		for (const a of due) await requestAttemptRecovery(ctx, a);
		return null;
	}
});
export const checkStatus = action({
	args: { ...memberArgs, ...attemptArgs },
	returns: v.null(),
	handler: async (ctx, args) => {
		const row: Attempt = await ctx.runQuery(internal.csmBookings.readOwned, args);
		if (row.state === 'booked') return null;
		await limiter.limit(ctx, 'status', { key: args.membershipId, throws: true });
		try {
			await ctx.runMutation(internal.csmBookings.requestRecovery, { attemptId: args.attemptId });
		} catch {
			throw new ConvexError('Booking status could not be checked. Please try again shortly.');
		}
		return null;
	}
});
/** Shared setup progress reveals only state; the private locator belongs exclusively to its creator. */
async function setupProgressFor(
	ctx: QueryCtx,
	owner: CompanyAccess,
	replacement?: Replacement
): Promise<Infer<typeof replacementProgress>> {
	if (replacement) return sharedReplacement(ctx, owner, replacement);
	if (
		!permissionsForRole(owner.membership.role, owner.isOwner).manageTemplate ||
		owner.company.templateSourceId
	)
		return { state: 'unavailable' };
	if (await blockingInitialGuard(ctx, owner.companyId)) return { state: 'uncertain' };
	const booking = await resolveSetupBooking(ctx, owner.company);
	if (booking.kind === 'confirmed') return { state: 'completed' };
	if (booking.kind !== 'initial') return { state: 'unavailable' };
	const a = await pendingInitialSetup(ctx, owner.companyId);
	if (!a) return { state: 'ready' };
	return {
		state: a.state === 'unknown' ? 'uncertain' : 'in-progress',
		...(a.profileId === owner.profile._id && a.membershipId === owner.membership._id
			? { attemptId: a._id }
			: {})
	};
}
export const setupStatus = query({
	args: { ...memberArgs, replacement: v.optional(setupReplacement) },
	returns: replacementProgress,
	handler: async (ctx, a) =>
		setupProgressFor(
			ctx,
			await requirePermission(ctx, 'manageTemplate', a.membershipId),
			a.replacement
		)
});
export const requestSetupRecovery = internalMutation({
	args: { ...memberArgs, replacement: v.optional(setupReplacement) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const owner = await requirePermission(ctx, 'manageTemplate', args.membershipId);
		if (owner.company.templateSourceId) return null;
		let attempt: Attempt | null = null;
		if (args.replacement) {
			const source = await ctx.db.get('csmSetupAppointments', args.replacement.appointmentId);
			if (!source || source.companyId !== owner.companyId) return null;
			const progress = await replacementState(ctx, source);
			if (
				'attempt' in progress &&
				progress.attempt &&
				sameReplacement(progress.attempt.replacement, args.replacement) &&
				['uncertain', 'in-progress'].includes(progress.state)
			)
				attempt = progress.attempt;
		} else if ((await resolveSetupBooking(ctx, owner.company)).kind === 'initial')
			attempt = await pendingInitialSetup(ctx, owner.companyId);
		if (attempt) await requestAttemptRecovery(ctx, attempt);
		return null;
	}
});
export const checkSetup = action({
	args: { ...memberArgs, replacement: v.optional(setupReplacement) },
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.runMutation(internal.csmBookings.requestSetupRecovery, args);
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
		const b = a.attendeeEmail ? parseBooking(raw, a.attendeeEmail, a.providerScope) : null;
		const reference = attemptReference(a);
		if (
			!reference ||
			!b ||
			b.uid !== args.uid ||
			b.status !== 'accepted' ||
			!object(raw) ||
			!object(raw.metadata) ||
			raw.metadata.dinuCsmAttempt !== reference ||
			(!b.fromUid && b.start !== a.requestedStart)
		)
			throw new ConvexError(
				'Cal did not verify an accepted booking with this exact attempt association.'
			);
		await ctx.runMutation(internal.csmBookings.settleCreation, {
			attemptId: a._id,
			reference: reference!,
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
/** Negative resolution requires terminal-before-investigation proof; positive uses resolveConfirmed. */
export const resolveUnknown = internalMutation({
	args: {
		...attemptArgs,
		...operatorEvidence,
		proof: v.optional(terminalProof),
		resolution: v.object({
			kind: v.literal('notCreated'),
			basis: v.literal('providerInvestigation')
		})
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
		const operatorResolution = {
			operator: args.operator,
			evidence: args.evidence,
			reason: args.reason,
			at: Date.now()
		};
		if (!sameProof(a, args.proof))
			throw new ConvexError(
				'Observe the sender before investigating noncreation, then supply that terminal proof.'
			);
		await patchAttempt(ctx, a, {
			state: 'failed',
			error: 'interrupted',
			failureBasis: 'providerInvestigation',
			operatorResolution,
			lineage: undefined,
			reviewRequired: undefined
		});

		return null;
	}
});
export const readReference = internalQuery({
	args: { reference: v.string() },
	returns: v.union(schema.doc('csmBookingAttempts'), v.null()),
	handler: async (ctx, { reference }) => {
		const locator = attemptIdFromReference(reference);
		const id = locator ? ctx.db.normalizeId('csmBookingAttempts', locator) : null;
		const a = id ? await ctx.db.get('csmBookingAttempts', id) : null;
		return a && reference === attemptReference(a) && (await liveAttempt(ctx, a)) ? a : null;
	}
});
function referencedAttempt(ctx: ActionCtx, reference: string): Promise<Attempt | null> {
	return ctx.runQuery(internal.csmBookings.readReference, { reference });
}
/** Drains old scheduled names into durable GET-only evidence; no provider IO here. */
export const recoverWebhook = internalAction({
	args: {
		reference: v.optional(v.string()),
		uid: v.string(),
		previousUid: v.optional(v.string()),
		successorHint: v.optional(v.string())
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.runMutation(internal.csmEvidence.ingress, { ...args, event: 'RECOVERY_HINT' });
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
			'BOOKING_REJECTED',
			'BOOKING_LOCATION_UPDATED'
		].includes(event.triggerEvent)
	)
		return new Response(null, { status: 204 });
	const p = event.payload;
	if (!object(p) || !validBookingUid(p.uid))
		return new Response('Invalid booking', { status: 400 });
	// Delivery HMAC authenticates ingress; stored scope plus provider GET authenticates facts.
	// Missing webhook numeric scope is retained for attribution, never authorized by a mutable name.
	const metadata = object(p.metadata) ? p.metadata : {};
	const rescheduled = event.triggerEvent === 'BOOKING_RESCHEDULED';
	const hints = {
		...(rescheduled && validBookingUid(p.rescheduleUid) ? { previousUid: p.rescheduleUid } : {}),
		...(rescheduled ? { successorHint: p.uid } : {})
	};
	// Presence of native metadata, including malformed metadata, forbids historical fallback.
	if (
		metadata.dinuCsmAttempt !== undefined &&
		(typeof metadata.dinuCsmAttempt !== 'string' || metadata.dinuCsmAttempt.length > 500)
	)
		return new Response('Invalid booking reference', { status: 400 });
	if (
		metadata.dinuCsmReference !== undefined &&
		(typeof metadata.dinuCsmReference !== 'string' || metadata.dinuCsmReference.length > 500)
	)
		return new Response('Invalid booking reference', { status: 400 });
	const occurrence = iso(p.updatedAt) ?? iso(event.createdAt) ?? undefined;
	const revision =
		typeof p.revision === 'number' && Number.isSafeInteger(p.revision) && p.revision >= 0
			? String(p.revision)
			: undefined;
	const organizer = object(p.organizer) ? p.organizer.id : undefined;
	const scope =
		typeof p.eventTypeId === 'number' &&
		Number.isSafeInteger(p.eventTypeId) &&
		p.eventTypeId > 0 &&
		typeof organizer === 'number' &&
		Number.isSafeInteger(organizer) &&
		organizer > 0
			? { eventTypeId: p.eventTypeId, organizerId: organizer }
			: undefined;
	try {
		await ctx.runMutation(internal.csmMeetingPreparation.hint, {
			uid: p.uid,
			...(hints.previousUid ? { previousUid: hints.previousUid } : {}),
			...(typeof metadata.dinuCsmAttempt === 'string' ? { reference: metadata.dinuCsmAttempt } : {})
		});
		const retained = await ctx.runMutation(internal.csmEvidence.ingress, {
			uid: p.uid,
			event: event.triggerEvent as
				| 'BOOKING_CREATED'
				| 'BOOKING_REQUESTED'
				| 'BOOKING_RESCHEDULED'
				| 'BOOKING_CANCELLED'
				| 'BOOKING_REJECTED'
				| 'BOOKING_LOCATION_UPDATED',
			...hints,
			...(scope ? { scope } : {}),
			...(occurrence ? { occurrence } : {}),
			...(revision ? { revision } : {}),
			...(typeof metadata.dinuCsmAttempt === 'string'
				? { reference: metadata.dinuCsmAttempt }
				: typeof metadata.dinuCsmReference === 'string'
					? { historicalReference: metadata.dinuCsmReference }
					: {})
		});
		if (retained.kind === 'needsRetention')
			return new Response('Booking evidence could not be retained', { status: 503 });
	} catch {
		return new Response('Booking evidence could not be retained', { status: 503 });
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
			videoProvider: config.videoProvider,
			slotCount: times.length
		};
	}
});
