/** Internal structural review. No timer, direct GET subset or customer control clears obligations. */
import { v, type Infer } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import schema from './schema';
import { calRead, object, parseSetupBooking, validBookingUid } from './csmCal';
import { attemptReference } from './csmHistory';
import { validProviderScope } from './csmIdentity';
import { retirePendingSetupJobs } from './csmSetupLifecycle';
import { setupReviewAttestation } from './csmSetupValidators';
import { pendingSuccessors } from './csmSetupChain';
import {
	applySetupProof,
	ownerState,
	setupProof,
	validReviewAttestation
} from './csmSetupAppointments';

const expectedReview = {
	id: v.id('csmSetupAppointments'),
	generation: v.number(),
	evidenceGeneration: v.number(),
	currentUid: v.string()
};
const reviewToken = { ...expectedReview, lease: v.number() };
const snapshot = v.union(
	v.null(),
	v.object({
		appointment: schema.doc('csmSetupAppointments'),
		reference: v.optional(v.string())
	})
);
const REVIEW_WINDOW = 30 * 60_000;
function matches(
	a: Doc<'csmSetupAppointments'>,
	expected: { generation: number; evidenceGeneration: number; currentUid: string }
) {
	return (
		a.generation === expected.generation &&
		(a.evidenceGeneration ?? 0) === expected.evidenceGeneration &&
		a.currentUid === expected.currentUid
	);
}
/** Inspect IDs/reasons, then freeze this exact target before enumerating its evidence. */
export const inspect = internalQuery({
	args: { id: v.id('csmSetupAppointments') },
	returns: v.union(v.null(), schema.doc('csmSetupAppointments')),
	handler: (ctx, { id }) => ctx.db.get('csmSetupAppointments', id)
});
export const begin = internalMutation({
	args: expectedReview,
	returns: snapshot,
	handler: async (ctx, args): Promise<Infer<typeof snapshot>> => {
		const a = await ctx.db.get('csmSetupAppointments', args.id);
		const reason =
			a?.reviewReason ??
			(a && (pendingSuccessors(a).overflow || a.issue === 'cap') ? 'cap' : undefined);
		if (
			!a ||
			!matches(a, args) ||
			!reason ||
			a.superseded ||
			a.maintenanceRetired ||
			(await ownerState(ctx, a)) !== 'active' ||
			(a.leaseUntil ?? 0) > Date.now()
		)
			return null;
		const original =
			a.attemptId && !a.attemptReference
				? await ctx.db.get('csmBookingAttempts', a.attemptId)
				: null;
		const reference = a.attemptReference ?? (original ? attemptReference(original) : null);
		if (
			!validProviderScope(a.providerScope) ||
			(a.source === 'native' ? !reference : !a.legacyReference)
		)
			return null;
		await retirePendingSetupJobs(ctx, a);
		const now = Date.now();
		const reviewSession = {
			lease: a.lease + 1,
			generation: a.generation,
			evidenceGeneration: a.evidenceGeneration ?? 0,
			currentUid: a.currentUid,
			startedAt: now,
			expiresAt: now + REVIEW_WINDOW,
			cursor: null,
			inspected: 0,
			isDone: false
		};
		await ctx.db.patch('csmSetupAppointments', a._id, {
			reviewReason: reason,
			dirty: true,
			lease: reviewSession.lease,
			leaseUntil: reviewSession.expiresAt,
			reviewSession,
			refreshJobId: undefined,
			deadlineJobId: undefined,
			repairAt: undefined
		});
		return {
			appointment: {
				...a,
				reviewReason: reason,
				dirty: true,
				lease: reviewSession.lease,
				leaseUntil: reviewSession.expiresAt,
				reviewSession
			},
			...(reference ? { reference } : {})
		};
	}
});
/** Every retained record is enumerated, in fixed pages. A first bounded sample is never exhaustive. */
export const scan = internalMutation({
	args: { ...reviewToken, cursor: v.union(v.string(), v.null()) },
	returns: v.union(
		v.null(),
		v.object({
			page: v.array(schema.doc('csmWebhookEvidence')),
			cursor: v.string(),
			isDone: v.boolean(),
			inspected: v.number()
		})
	),
	handler: async (ctx, args) => {
		const a = await ctx.db.get('csmSetupAppointments', args.id);
		const session = a?.reviewSession;
		if (
			!a ||
			!matches(a, args) ||
			!session ||
			session.lease !== args.lease ||
			session.evidenceGeneration !== args.evidenceGeneration ||
			session.currentUid !== args.currentUid ||
			session.generation !== args.generation ||
			session.expiresAt <= Date.now() ||
			session.isDone ||
			session.cursor !== args.cursor ||
			(await ownerState(ctx, a)) !== 'active' ||
			a.superseded ||
			a.maintenanceRetired
		)
			return null;
		const page = await ctx.db
			.query('csmWebhookEvidence')
			.withIndex('by_appointmentId_and_state_and_evidenceGeneration', (q) =>
				q.eq('appointmentId', a._id).eq('state', 'retained')
			)
			.paginate({ cursor: args.cursor, numItems: 25 });
		const inspected = session.inspected + page.page.length;
		await ctx.db.patch('csmSetupAppointments', a._id, {
			reviewSession: { ...session, cursor: page.continueCursor, inspected, isDone: page.isDone }
		});
		return { page: page.page, cursor: page.continueCursor, isDone: page.isDone, inspected };
	}
});
export const read = internalQuery({
	args: reviewToken,
	returns: snapshot,
	handler: async (ctx, args): Promise<Infer<typeof snapshot>> => {
		const a = await ctx.db.get('csmSetupAppointments', args.id);
		const session = a?.reviewSession;
		if (
			!a ||
			!matches(a, args) ||
			!a.reviewReason ||
			a.superseded ||
			a.maintenanceRetired ||
			!session?.isDone ||
			session.lease !== args.lease ||
			session.generation !== args.generation ||
			session.evidenceGeneration !== args.evidenceGeneration ||
			session.currentUid !== args.currentUid ||
			session.expiresAt <= Date.now() ||
			a.lease !== args.lease ||
			(await ownerState(ctx, a)) !== 'active'
		)
			return null;
		const original =
			a.attemptId && !a.attemptReference
				? await ctx.db.get('csmBookingAttempts', a.attemptId)
				: null;
		const reference = a.attemptReference ?? (original ? attemptReference(original) : null);
		return { appointment: a, ...(reference ? { reference } : {}) };
	}
});
export const commit = internalMutation({
	args: setupProof.fields,
	returns: v.boolean(),
	handler: async (ctx, args) => {
		if (!args.reviewed || args.result.kind !== 'success') return false;
		await applySetupProof(ctx, args);
		const a = await ctx.db.get('csmSetupAppointments', args.id);
		return (
			a?.reviewedResolution?.lease === args.lease &&
			a.reviewedResolution.evidenceGeneration === args.evidenceGeneration &&
			!a.reviewReason &&
			a.currentUid === args.result.booking.uid
		);
	}
});
/** Exhaustive original-association investigation must cover every scan page and any old lost overflow. */
export const resolve = internalAction({
	args: { ...reviewToken, leafUid: v.string(), attestation: setupReviewAttestation },
	returns: v.boolean(),
	handler: async (ctx, args): Promise<boolean> => {
		if (!validBookingUid(args.leafUid) || !validReviewAttestation(args.attestation)) return false;
		const frozen: Infer<typeof snapshot> = await ctx.runQuery(internal.csmSetupReview.read, {
			id: args.id,
			generation: args.generation,
			evidenceGeneration: args.evidenceGeneration,
			currentUid: args.currentUid,
			lease: args.lease
		});
		if (!frozen || !validProviderScope(frozen.appointment.providerScope)) return false;
		const a = frozen.appointment;
		const proofUids = [...new Set([a.anchorUid, a.currentUid, args.leafUid])];
		const deadline = Date.now() + 45_000;
		let leaf: ReturnType<typeof parseSetupBooking> = null;
		for (const uid of proofUids) {
			if (!validBookingUid(uid) || Date.now() + 12_000 > deadline) return false;
			const raw = await calRead(ctx, `bookings/${encodeURIComponent(uid)}`, '2026-02-25');
			const booking = parseSetupBooking(raw, uid, {
				companyId: a.companyId,
				profileId: a.profileId,
				providerScope: a.providerScope,
				attemptReference: frozen.reference,
				legacyReference: a.legacyReference
			});
			if (!booking) return false;
			if (uid === args.leafUid) {
				if (booking.toUid || booking.status === 'pending') return false;
				// A proposed new locator needs fresh exact original association, in addition to human attestation.
				if (
					uid !== a.currentUid &&
					(!object(raw) ||
						!object(raw.metadata) ||
						(a.source === 'native'
							? raw.metadata.dinuCsmAttempt !== frozen.reference
							: raw.metadata.dinuCsmReference !== a.legacyReference))
				)
					return false;
				leaf = booking;
			}
		}
		if (!leaf) return false;
		return ctx.runMutation(internal.csmSetupReview.commit, {
			id: args.id,
			generation: args.generation,
			evidenceGeneration: args.evidenceGeneration,
			currentUid: args.currentUid,
			lease: args.lease,
			providerScope: a.providerScope!,
			...(frozen.reference ? { reference: frozen.reference } : {}),
			...(a.legacyReference ? { legacyReference: a.legacyReference } : {}),
			evidenceIds: [],
			reviewed: args.attestation,
			result: { kind: 'success', booking: leaf, proofUids }
		});
	}
});
/** Reviewed disposition covers only the frozen evidence generation. New arrivals remain outstanding. */
export const completeEvidence = internalMutation({
	args: { id: v.id('csmSetupAppointments'), evidenceGeneration: v.number(), lease: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const a = await ctx.db.get('csmSetupAppointments', args.id);
		if (
			!a ||
			a.reviewedResolution?.evidenceGeneration !== args.evidenceGeneration ||
			a.reviewedResolution.lease !== args.lease
		)
			return null;
		const rows = await ctx.db
			.query('csmWebhookEvidence')
			.withIndex('by_appointmentId_and_state_and_evidenceGeneration', (q) =>
				q
					.eq('appointmentId', a._id)
					.eq('state', 'retained')
					.lte('evidenceGeneration', args.evidenceGeneration)
			)
			.take(25);
		let completed = 0;
		for (const row of rows) {
			if ((row.evidenceGeneration ?? 0) > args.evidenceGeneration) continue;
			await ctx.db.patch('csmWebhookEvidence', row._id, {
				state: 'completed',
				completedAt: Date.now(),
				reviewReason: 'exhaustiveAppointmentReview'
			});
			completed++;
		}
		if (rows.length === 25 && completed)
			await ctx.scheduler.runAfter(0, internal.csmSetupReview.completeEvidence, args);
		return null;
	}
});
/** Explicit rollout diagnostics include old lossy overflow even before normalization. */
export const inventory = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: v.object({
		cursor: v.string(),
		isDone: v.boolean(),
		scanned: v.number(),
		review: v.array(v.object({ ...expectedReview, reason: v.string(), lostOverflow: v.boolean() })),
		releasedRetirementRemaining: v.array(v.id('csmSetupAppointments'))
	}),
	handler: async (ctx, { cursor }) => {
		const page = await ctx.db
			.query('csmSetupAppointments')
			.withIndex('by_creation_time')
			.paginate({ cursor, numItems: 25 });
		const review = [];
		const releasedRetirementRemaining = [];
		for (const a of page.page) {
			const lostOverflow = pendingSuccessors(a).overflow;
			if (a.reviewReason || lostOverflow || a.issue === 'cap')
				review.push({
					id: a._id,
					generation: a.generation,
					evidenceGeneration: a.evidenceGeneration ?? 0,
					currentUid: a.currentUid,
					reason: a.reviewReason ?? 'cap',
					lostOverflow
				});
			if (
				!a.superseded &&
				(await ownerState(ctx, a)) === 'released' &&
				(!a.maintenanceRetired ||
					a.repairAt !== undefined ||
					a.leaseUntil !== undefined ||
					a.refreshJobId !== undefined ||
					a.deadlineJobId !== undefined)
			)
				releasedRetirementRemaining.push(a._id);
		}
		return {
			cursor: page.continueCursor,
			isDone: page.isDone,
			scanned: page.page.length,
			review,
			releasedRetirementRemaining
		};
	}
});
