/** Historical admission and bounded rollout tools; never a current client protocol. */
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { internalAction, internalMutation, type ActionCtx } from './_generated/server';
import { calRead, calRequest, object, parseSetupBooking, validBookingUid } from './csmCal';
import { providerBooking, providerScope } from './csmBookingValidators';
import { parseCompanyReference, historicalProviderScope, HISTORICAL_EVENT_ID } from './csmHistory';
import { coversSetupProof, proveSetupChain, SetupChainError } from './csmSetupChain';
import {
	ownerState,
	remove,
	represented,
	compatibleLegacy,
	oldest,
	enqueue,
	initializeAppointment
} from './csmSetupAppointments';
type Appointment = Doc<'csmSetupAppointments'>;

export const seedLegacy = internalMutation({
	args: {
		companyReference: v.string(),
		profileReference: v.string(),
		providerScope,
		legacyReference: v.string(),
		anchor: providerBooking,
		booking: providerBooking,
		admittedUid: v.string(),
		proofUids: v.array(v.string()),
		successorHint: v.optional(v.string())
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const reference = await parseCompanyReference(args.legacyReference);
		if (
			!reference ||
			reference.mode !== 'setup' ||
			reference.companyId !== args.companyReference ||
			(reference.profileId && reference.profileId !== args.profileReference) ||
			args.providerScope.eventTypeId !== HISTORICAL_EVENT_ID
		)
			return false;
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
				// The same authenticated full-chain admission can normalize an existing original binding.
				// Source-unbound links reached this mutation only through reviewed original-profile proof.
				if (!survivor.providerScope && !survivor.legacyReference)
					await ctx.db.patch('csmSetupAppointments', survivor._id, {
						providerScope: args.providerScope,
						legacyReference: args.legacyReference
					});
				await enqueue(ctx, survivor, { successorHint: args.booking.uid });
				if (args.successorHint !== undefined) {
					const updated = (await ctx.db.get('csmSetupAppointments', survivor._id))!;
					await enqueue(ctx, updated, { successorHint: args.successorHint });
				}
			}
			return false;
		}
		return !!(await initializeAppointment(
			ctx,
			{
				companyId,
				profileId,
				source: 'legacy',
				providerScope: args.providerScope,
				legacyReference: args.legacyReference,
				anchorUid: args.anchor.uid,
				...(args.booking.status !== 'pending'
					? {
							confirmedBooking: {
								status:
									args.booking.status === 'accepted'
										? ('accepted' as const)
										: ('cancelled' as const),
								uid: args.booking.uid,
								start: args.booking.start,
								end: args.booking.end,
								confirmedAt: Date.now(),
								providerUpdatedAt: args.booking.updatedAt
							}
						}
					: {})
			},
			args.booking,
			args.successorHint
		));
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
	const frozenScope = historicalProviderScope(raw);
	if (!frozenScope) return false;
	const scope = {
		companyId: reference.companyId,
		profileId,
		providerScope: frozenScope,
		legacyReference: raw.metadata.dinuCsmReference
	};
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
	return ctx.runMutation(internal.csmHistoricalAppointments.seedLegacy, {
		companyReference: reference.companyId,
		profileReference: profileId,
		providerScope: frozenScope,
		legacyReference: raw.metadata.dinuCsmReference,
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
		const params = new URLSearchParams({ eventTypeId: String(HISTORICAL_EVENT_ID), limit: '100' });
		if (args.cursor) params.set('cursor', args.cursor);
		const response = await calRequest(ctx, `bookings?${params}`, '2026-05-01', 'GET');
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
