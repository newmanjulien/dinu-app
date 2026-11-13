/** Explicit, bounded rollout inventory/conversion. No invocation is part of local implementation. */
import { v, type Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import {
	internalAction,
	internalMutation,
	internalQuery,
	type MutationCtx
} from './_generated/server';
import schema from './schema';
import { availableCompany, companyDeletion, liveProfile } from './auth';
import { canonicalState, confirmedEvidence, safeFailedEvidence } from './csmAttemptState';
import { patchAttempt } from './csmBookings';
import { recoveryEnrollment, enrollAttemptRecovery } from './csmRecoveryPolicy';
import { pendingSuccessors } from './csmSetupChain';
import {
	readConfirmedSetupBooking,
	pendingInitialSetup,
	resolveSetupBooking
} from './csmSetupState';
import { seedSetupAppointment, ownerState, retainSetupReview } from './csmSetupAppointments';
import {
	retireSupersededSetupAppointment,
	retireReleasedSetupAppointment,
	needsSupersededSetupRetirement
} from './csmSetupLifecycle';
import { blockingInitialGuard } from './csmErasureGuards';
import { attemptReference, historicalProviderScope, parseCompanyReference } from './csmHistory';
import { sameProviderScope, validProviderScope } from './csmIdentity';
import { calRead, object, parseBooking, parseSetupBooking, validBookingUid } from './csmCal';
import { providerScope } from './csmBookingValidators';

type Attempt = Doc<'csmBookingAttempts'>;
type Appointment = Doc<'csmSetupAppointments'>;
const paging = { numItems: 25, maximumRowsRead: 25, maximumBytesRead: 2_000_000 };
const summary = v.object({
	cursor: v.string(),
	isDone: v.boolean(),
	scanned: v.number(),
	changed: v.number(),
	convertible: v.number(),
	convertedUnknown: v.number(),
	enrollmentEligible: v.number(),
	enrollmentNeeded: v.number(),
	enrollmentAdded: v.number(),
	legacyIds: v.array(v.string()),
	unresolved: v.array(v.object({ id: v.string(), reason: v.string() }))
});
function report(page: {
	continueCursor: string;
	isDone: boolean;
	page: unknown[];
}): Infer<typeof summary> {
	return {
		cursor: page.continueCursor,
		isDone: page.isDone,
		scanned: page.page.length,
		changed: 0,
		convertible: 0,
		convertedUnknown: 0,
		enrollmentEligible: 0,
		enrollmentNeeded: 0,
		enrollmentAdded: 0,
		legacyIds: [],
		unresolved: []
	};
}
/** One canonical reducer computes both the dry-run and apply state; no legacy terminal authority. */
function receiptConversion(a: Attempt) {
	const fields: Partial<Infer<typeof import('./csmBookingValidators').storedCsmAttempt>> = {};
	if (
		(a.state === 'failed' && !safeFailedEvidence(a)) ||
		(a.state === 'booked' && !confirmedEvidence(a))
	) {
		fields.state = 'unknown';
		fields.error = 'uncertain';
		fields.failureBasis = undefined;
	}
	const confirmed = a.state === 'booked' && !fields.state;
	if (confirmed) fields.providerUid = undefined;
	if (confirmed || safeFailedEvidence(a)) {
		fields.lineage = undefined;
		fields.reviewRequired = undefined;
		if (a.operatorResolution?.priorLineage) {
			const { priorLineage: _, ...resolution } = a.operatorResolution;
			fields.operatorResolution = resolution;
		}
	}
	if (a.senderTerminal && confirmed) fields.attendeeEmail = undefined;
	Object.assign(fields, canonicalState({ ...a, ...fields }));
	return fields;
}
async function receipts(ctx: MutationCtx, cursor: string | null, apply: boolean) {
	const page = await ctx.db
		.query('csmBookingAttempts')
		.withIndex('by_creation_time')
		.paginate({ cursor, ...paging });
	const result = report(page);
	for (const original of page.page) {
		if (
			original.format !== 2 ||
			original.eventTypeId !== undefined ||
			original.lineage !== undefined ||
			original.operatorResolution?.priorLineage
		)
			result.legacyIds.push(original._id);
		const fields = receiptConversion(original);
		const projected = { ...original, ...fields } as Attempt;
		const changed = Object.entries(fields).some(
			([key, value]) => JSON.stringify(original[key as keyof Attempt]) !== JSON.stringify(value)
		);
		if (changed) result.convertible++;
		if (original.state !== 'unknown' && projected.state === 'unknown') result.convertedUnknown++;
		const enrollment = recoveryEnrollment(projected);
		if (enrollment.kind === 'eligible') {
			result.enrollmentEligible++;
			if (projected.recoveryDue === undefined) result.enrollmentNeeded++;
		}
		if (enrollment.kind === 'review')
			result.unresolved.push({ id: original._id, reason: enrollment.reason });
		if (!validProviderScope(projected.providerScope) || !attemptReference(projected))
			result.unresolved.push({ id: original._id, reason: 'missingOriginalIdentity' });
		if (!apply) continue;
		if (changed) {
			if (fields.state !== original.state) await patchAttempt(ctx, original, fields);
			else await ctx.db.patch('csmBookingAttempts', original._id, fields);
		}
		const current = (await ctx.db.get('csmBookingAttempts', original._id))!;
		// Existing unknown without due fields and converted uncertainty use the same S04 reducer.
		if (current.state === 'unknown') await enrollAttemptRecovery(ctx, current);
		const updated = (await ctx.db.get('csmBookingAttempts', original._id))!;
		if (original.recoveryDue === undefined && updated.recoveryDue !== undefined)
			result.enrollmentAdded++;
		await seedSetupAppointment(ctx, updated);
		if (
			JSON.stringify(original) !==
			JSON.stringify(await ctx.db.get('csmBookingAttempts', original._id))
		)
			result.changed++;
	}
	return result;
}
async function appointments(ctx: MutationCtx, cursor: string | null, apply: boolean) {
	const page = await ctx.db
		.query('csmSetupAppointments')
		.withIndex('by_creation_time')
		.paginate({ cursor, ...paging });
	const result = report(page);
	for (const a of page.page) {
		const confirmed = await readConfirmedSetupBooking(ctx, a);
		const pending = pendingSuccessors(a);
		const ownership = await ownerState(ctx, a);
		const missingIdentity =
			!validProviderScope(a.providerScope) ||
			!(a.source === 'native' ? a.attemptReference : a.legacyReference);
		if (
			a.bookingConfirmation !== undefined ||
			a.successorHint !== undefined ||
			!a.pendingSuccessors
		)
			result.legacyIds.push(a._id);
		if (!confirmed && !a.superseded)
			result.unresolved.push({ id: a._id, reason: 'missingConfirmedSnapshot' });
		if (missingIdentity) result.unresolved.push({ id: a._id, reason: 'missingOriginalIdentity' });
		if (pending.overflow) result.unresolved.push({ id: a._id, reason: 'lostOverflowOrCap' });
		if (a.reviewReason) result.unresolved.push({ id: a._id, reason: a.reviewReason });
		const fields = {
			pendingSuccessors: pending,
			successorHint: undefined,
			...(confirmed ? { confirmedBooking: confirmed, bookingConfirmation: undefined } : {})
		};
		const convertible =
			Object.entries(fields).some(
				([key, value]) => JSON.stringify(a[key as keyof Appointment]) !== JSON.stringify(value)
			) ||
			needsSupersededSetupRetirement(a) ||
			(ownership === 'released' && a.maintenanceRetired !== 'released') ||
			(!a.superseded &&
				ownership === 'active' &&
				!a.reviewReason &&
				(missingIdentity || pending.overflow));
		if (convertible) result.convertible++;
		if (!apply) continue;
		await ctx.db.patch('csmSetupAppointments', a._id, fields);
		const updated = (await ctx.db.get('csmSetupAppointments', a._id))!;
		if (a.superseded) await retireSupersededSetupAppointment(ctx, updated);
		else if (ownership === 'released') await retireReleasedSetupAppointment(ctx, updated);
		else if (ownership === 'active' && !a.reviewReason && (missingIdentity || pending.overflow))
			await retainSetupReview(ctx, updated, pending.overflow ? 'cap' : 'missingOriginalProof');
		if (JSON.stringify(a) !== JSON.stringify(await ctx.db.get('csmSetupAppointments', a._id)))
			result.changed++;
	}
	return result;
}
async function companies(ctx: MutationCtx, cursor: string | null, apply: boolean) {
	const page = await ctx.db
		.query('company')
		.withIndex('by_creation_time')
		.paginate({ cursor, numItems: 10 });
	let recoverable = 0,
		updated = 0;
	const unresolved: {
		companyId: Id<'company'>;
		reason:
			| 'invalid-current'
			| 'booking-in-progress'
			| 'history-limit'
			| 'ambiguous-history'
			| 'unconfirmed';
	}[] = [];
	for (const company of page.page) {
		if (company.templateSourceId || (await companyDeletion(ctx, company._id))) continue;
		if (company.setupAppointmentId) {
			if ((await resolveSetupBooking(ctx, company)).kind === 'unavailable')
				unresolved.push({ companyId: company._id, reason: 'invalid-current' });
			continue;
		}
		if (
			(await pendingInitialSetup(ctx, company._id)) ||
			(await blockingInitialGuard(ctx, company._id))
		) {
			unresolved.push({ companyId: company._id, reason: 'booking-in-progress' });
			continue;
		}
		// Prefix range covers all selections, including hidden and superseded history.
		const rows = await ctx.db
			.query('csmSetupAppointments')
			.withIndex('by_companyId_and_selection_and_sortAt_and_anchorUid', (q) =>
				q.eq('companyId', company._id)
			)
			.take(26);
		if (rows.length === 26) {
			unresolved.push({ companyId: company._id, reason: 'history-limit' });
			continue;
		}
		const candidates: Appointment[] = [];
		for (const row of rows) {
			if (!row.superseded && (await liveProfile(ctx, row.profileId))) candidates.push(row);
		}
		if (!candidates.length) continue;
		if (candidates.length !== 1) {
			unresolved.push({ companyId: company._id, reason: 'ambiguous-history' });
			continue;
		}
		const a = candidates[0];
		const confirmed = await readConfirmedSetupBooking(ctx, a);
		if (!confirmed || a.erasedReplacementUncertain || a.replacementAttemptId) {
			unresolved.push({ companyId: company._id, reason: 'unconfirmed' });
			continue;
		}
		recoverable++;
		if (apply) {
			await ctx.db.patch('csmSetupAppointments', a._id, { confirmedBooking: confirmed });
			await ctx.db.patch('company', company._id, { setupAppointmentId: a._id });
			updated++;
		}
	}
	return {
		cursor: page.continueCursor,
		isDone: page.isDone,
		scanned: page.page.length,
		changed: updated,
		convertible: recoverable,
		convertedUnknown: 0,
		enrollmentEligible: 0,
		enrollmentNeeded: 0,
		enrollmentAdded: 0,
		legacyIds: [],
		unresolved: unresolved.map(({ companyId, reason }) => ({ id: companyId, reason }))
	};
}
/** Dry-run is the default at the runbook; apply requires a separately authorized data pass. */
export const normalize = internalMutation({
	args: {
		population: v.union(v.literal('attempts'), v.literal('appointments'), v.literal('companies')),
		cursor: v.union(v.string(), v.null()),
		apply: v.boolean()
	},
	returns: summary,
	handler: (ctx, { population, cursor, apply }) =>
		population === 'attempts'
			? receipts(ctx, cursor, apply)
			: population === 'appointments'
				? appointments(ctx, cursor, apply)
				: companies(ctx, cursor, apply)
});
const target = v.union(
	v.object({ kind: v.literal('attempt'), id: v.id('csmBookingAttempts') }),
	v.object({ kind: v.literal('appointment'), id: v.id('csmSetupAppointments') })
);
const snapshot = v.union(
	v.null(),
	v.object({ kind: v.literal('attempt'), row: schema.doc('csmBookingAttempts') }),
	v.object({ kind: v.literal('appointment'), row: schema.doc('csmSetupAppointments') })
);
export const identitySnapshot = internalQuery({
	args: { target },
	returns: snapshot,
	handler: async (ctx, { target }) => {
		if (target.kind === 'attempt') {
			const row = await ctx.db.get('csmBookingAttempts', target.id);
			return row ? { kind: 'attempt' as const, row } : null;
		}
		const row = await ctx.db.get('csmSetupAppointments', target.id);
		return row ? { kind: 'appointment' as const, row } : null;
	}
});
export const freezeIdentity = internalMutation({
	args: {
		target,
		expectedRevision: v.number(),
		expectedCurrentUid: v.optional(v.string()),
		reference: v.string(),
		providerScope
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		if (!validProviderScope(args.providerScope)) return false;
		if (args.target.kind === 'attempt') {
			const a = await ctx.db.get('csmBookingAttempts', args.target.id);
			if (
				!a ||
				a.revision !== args.expectedRevision ||
				a.providerScope ||
				a.attemptReference ||
				a.dispatchId ||
				attemptReference(a) !== args.reference ||
				!(await liveProfile(ctx, a.profileId)) ||
				!(await availableCompany(ctx, a.companyId))
			)
				return false;
			await ctx.db.patch('csmBookingAttempts', a._id, {
				providerScope: args.providerScope,
				attemptReference: args.reference,
				eventTypeId: undefined,
				...(a.recoveryReview === 'missingOriginalProof' ? { recoveryReview: undefined } : {})
			});
			await enrollAttemptRecovery(ctx, (await ctx.db.get('csmBookingAttempts', a._id))!);
			return true;
		}
		const a = await ctx.db.get('csmSetupAppointments', args.target.id);
		if (
			!a ||
			a.generation !== args.expectedRevision ||
			a.currentUid !== args.expectedCurrentUid ||
			a.providerScope ||
			(await ownerState(ctx, a)) === 'erased' ||
			(await ownerState(ctx, a)) === 'paused'
		)
			return false;
		if (a.source === 'legacy') {
			const parsed = await parseCompanyReference(args.reference);
			if (
				!parsed ||
				parsed.mode !== 'setup' ||
				parsed.companyId !== a.companyId ||
				parsed.profileId !== a.profileId
			)
				return false;
		} else {
			const attempt = a.attemptId ? await ctx.db.get('csmBookingAttempts', a.attemptId) : null;
			if (
				!attempt ||
				attempt.companyId !== a.companyId ||
				attempt.profileId !== a.profileId ||
				attemptReference(attempt) !== args.reference ||
				(attempt.providerScope !== undefined &&
					!sameProviderScope(attempt.providerScope, args.providerScope))
			)
				return false;
		}
		await ctx.db.patch('csmSetupAppointments', a._id, {
			providerScope: args.providerScope,
			...(a.source === 'native'
				? { attemptReference: args.reference }
				: { legacyReference: args.reference })
		});
		return true;
	}
});
/** One supplied locator, authenticated original identity/attendee association, no POST or state publication. */
export const verifyIdentity = internalAction({
	args: { target, uid: v.string() },
	returns: v.boolean(),
	handler: async (ctx, args): Promise<boolean> => {
		if (!validBookingUid(args.uid)) return false;
		const saved: Infer<typeof snapshot> = await ctx.runQuery(
			internal.csmMaintenance.identitySnapshot,
			{ target: args.target }
		);
		if (!saved) return false;
		const raw = await calRead(ctx, `bookings/${encodeURIComponent(args.uid)}`, '2026-02-25');
		if (!object(raw) || !object(raw.metadata)) return false;
		const scope = historicalProviderScope(raw);
		if (!scope) return false;
		let reference: string | null;
		if (saved.kind === 'attempt') {
			const a = saved.row;
			reference = attemptReference(a);
			if (
				!reference ||
				!a.attendeeEmail ||
				raw.metadata.dinuCsmAttempt !== reference ||
				!parseBooking(raw, a.attendeeEmail, scope)
			)
				return false;
		} else {
			const a = saved.row;
			reference =
				typeof raw.metadata.dinuCsmAttempt === 'string' && a.source === 'native'
					? raw.metadata.dinuCsmAttempt
					: typeof raw.metadata.dinuCsmReference === 'string' &&
						  a.source === 'legacy' &&
						  raw.metadata.dinuCsmAttempt === undefined
						? raw.metadata.dinuCsmReference
						: null;
			if (
				!reference ||
				(args.uid !== a.anchorUid && args.uid !== a.currentUid) ||
				!parseSetupBooking(raw, args.uid, {
					companyId: a.companyId,
					profileId: a.profileId,
					providerScope: scope,
					...(a.source === 'native'
						? { attemptReference: reference }
						: { legacyReference: reference })
				})
			)
				return false;
		}
		return ctx.runMutation(internal.csmMaintenance.freezeIdentity, {
			target: args.target,
			...(saved.kind === 'appointment' ? { expectedCurrentUid: saved.row.currentUid } : {}),
			expectedRevision: saved.kind === 'attempt' ? saved.row.revision : saved.row.generation,
			reference,
			providerScope: scope
		});
	}
});
