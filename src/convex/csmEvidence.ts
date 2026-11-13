/** Durable domain evidence: each semantic obligation has one identity, including overflow. */
import { v, type Infer } from 'convex/values';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { internal } from './_generated/api';
import {
	env,
	internalAction,
	internalMutation,
	type MutationCtx,
	type QueryCtx
} from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import schema from './schema';
import { availableCompany, liveProfile } from './auth';
import { evidenceHint, ingressResult } from './csmEvidenceValidators';
import { attemptIdFromReference } from './csmIdentity';
import { attemptReference, parseCompanyReference } from './csmHistory';
import { calRead, object, parseSetupLocator, bookingInScope, validBookingUid } from './csmCal';
import { notifySetupEvidence } from './csmSetupAppointments';
import { requestAttemptRecovery } from './csmBookings';
import { noteErasedInitialEvidence } from './csmErasureGuards';
import {
	EVIDENCE_PASSES,
	RECOVERY_LEASE,
	evidenceRetry,
	readFailure,
	recoveryDisposition
} from './csmRecoveryPolicy';
import { cancelJob } from './emailDeliveries';

type Evidence = Doc<'csmWebhookEvidence'>;
export type Hint = Infer<typeof evidenceHint>;
function nativeDispatchId(reference: string | undefined) {
	if (!reference || !attemptIdFromReference(reference)) return undefined;
	const parts = reference.split('.');
	return parts.length === 4 ? parts[2] : undefined;
}
export function evidenceIdentity(h: Hint) {
	// Positional canonical tuple: undefined is encoded as null; receipt time never participates.
	return bytesToHex(
		sha256(
			new TextEncoder().encode(
				JSON.stringify([
					env.CONVEX_CLOUD_URL,
					h.scope?.eventTypeId ?? null,
					h.scope?.organizerId ?? null,
					h.uid,
					h.event,
					h.reference ?? null,
					h.historicalReference ?? null,
					h.previousUid ?? null,
					h.successorHint ?? null,
					h.occurrence ?? null,
					h.revision ?? null
				])
			)
		)
	);
}
function validHint(h: Hint) {
	return (
		validBookingUid(h.uid) &&
		[h.previousUid, h.successorHint].every((x) => x === undefined || validBookingUid(x)) &&
		[h.reference, h.historicalReference].every(
			(x) => x === undefined || (x.length > 0 && x.length <= 500)
		) &&
		[h.occurrence, h.revision].every((x) => x === undefined || (x.length > 0 && x.length <= 128)) &&
		(!h.scope ||
			[h.scope.eventTypeId, h.scope.organizerId].every((x) => Number.isSafeInteger(x) && x > 0))
	);
}
async function scrub(ctx: MutationCtx, row: Evidence, state: 'erased' | 'completed') {
	await cancelJob(ctx, row.jobId);
	await ctx.db.replace('csmWebhookEvidence', row._id, {
		identity: row.identity,
		...(row.dispatchId ? { dispatchId: row.dispatchId } : {}),
		state,
		generation: row.generation + 1,
		lease: row.lease,
		failures: row.failures,
		completedAt: Date.now()
	});
}
/** Erasure keeps only a bounded opaque duplicate identity; no private association can resurrect. */
export async function eraseTargetEvidence(
	ctx: MutationCtx,
	target: { attemptId?: Id<'csmBookingAttempts'>; appointmentId?: Id<'csmSetupAppointments'> }
) {
	const rows = target.attemptId
		? await ctx.db
				.query('csmWebhookEvidence')
				.withIndex('by_attemptId', (q) => q.eq('attemptId', target.attemptId))
				.take(26)
		: await ctx.db
				.query('csmWebhookEvidence')
				.withIndex('by_appointmentId', (q) => q.eq('appointmentId', target.appointmentId))
				.take(26);
	for (const row of rows.slice(0, 25)) await scrub(ctx, row, 'erased');
	return rows.length <= 25;
}
export async function eraseProfileEvidence(ctx: MutationCtx, profileId: Id<'profiles'>) {
	const rows = await ctx.db
		.query('csmWebhookEvidence')
		.withIndex('by_profileId', (q) => q.eq('profileId', profileId))
		.take(25);
	for (const row of rows) await scrub(ctx, row, 'erased');
	return rows.length < 25;
}
async function attributeAttempt(ctx: MutationCtx, row: Evidence, a: Doc<'csmBookingAttempts'>) {
	if (!(await availableCompany(ctx, a.companyId)) || !(await liveProfile(ctx, a.profileId))) {
		await scrub(ctx, row, 'erased');
		return;
	}
	if (a.state === 'booked' && a.mode === 'setup') {
		const result = await notifySetupEvidence(ctx, row, { attemptId: a._id });
		if (result.kind === 'retained') return;
		await ctx.db.patch('csmWebhookEvidence', row._id, {
			companyId: a.companyId,
			profileId: a.profileId,
			attemptId: a._id,
			state: 'review',
			dueAt: undefined,
			leaseUntil: undefined,
			reviewReason: 'appointmentUnavailable',
			generation: row.generation + 1
		});
		return;
	}
	if (a.state === 'booked') {
		await ctx.db.patch('csmWebhookEvidence', row._id, {
			companyId: a.companyId,
			profileId: a.profileId,
			attemptId: a._id,
			state: 'completed',
			dueAt: undefined,
			leaseUntil: undefined,
			completedAt: Date.now(),
			generation: row.generation + 1
		});
		return;
	}
	await requestAttemptRecovery(ctx, a, row.hint!.uid, true);
	const updated = (await ctx.db.get('csmBookingAttempts', a._id))!;
	await ctx.db.patch('csmWebhookEvidence', row._id, {
		attemptId: a._id,
		companyId: a.companyId,
		profileId: a.profileId,
		state: 'retained',
		dueAt: undefined,
		evidenceGeneration: updated.recoveryGeneration ?? 0,
		generation: row.generation + 1
	});
}
export const ingress = internalMutation({
	args: evidenceHint.fields,
	returns: ingressResult,
	handler: async (ctx, h): Promise<Infer<typeof ingressResult>> => {
		if (!validHint(h)) throw new Error('Invalid bounded booking evidence.');
		const identity = evidenceIdentity(h);
		const existing = await ctx.db
			.query('csmWebhookEvidence')
			.withIndex('by_identity', (q) => q.eq('identity', identity))
			.unique();
		if (existing) return { kind: 'duplicate' };
		const id = await ctx.db.insert('csmWebhookEvidence', {
			identity,
			dispatchId: nativeDispatchId(h.reference),
			hint: h,
			state: 'queued',
			generation: 0,
			lease: 0,
			failures: 0,
			dueAt: Date.now()
		});
		const row = (await ctx.db.get('csmWebhookEvidence', id))!;
		if (h.reference !== undefined) {
			await noteErasedInitialEvidence(ctx, h.reference);
			const locator = attemptIdFromReference(h.reference);
			const attemptId = locator ? ctx.db.normalizeId('csmBookingAttempts', locator) : null;
			const a = attemptId ? await ctx.db.get('csmBookingAttempts', attemptId) : null;
			// Invalid purported native association never falls through to historical admission.
			if (!a || attemptReference(a) !== h.reference) {
				if ((await notifySetupEvidence(ctx, row)).kind === 'retained')
					return { kind: 'retained', evidenceId: id };
				await scrub(ctx, row, 'erased');
				return { kind: 'unrelated' };
			}
			await attributeAttempt(ctx, row, a);
		} else {
			const result = await notifySetupEvidence(ctx, row);
			if (result.kind !== 'retained' && h.historicalReference !== undefined) {
				const parsed = await parseCompanyReference(h.historicalReference);
				const companyId = parsed ? ctx.db.normalizeId('company', parsed.companyId) : null;
				const profileId = parsed?.profileId
					? ctx.db.normalizeId('profiles', parsed.profileId)
					: null;
				if (!parsed || parsed.mode !== 'setup') {
					await scrub(ctx, row, 'completed');
					return { kind: 'unrelated' };
				}
				if (
					!companyId ||
					!(await availableCompany(ctx, companyId)) ||
					(profileId && !(await liveProfile(ctx, profileId)))
				) {
					await scrub(ctx, row, 'erased');
					return { kind: 'unrelated' };
				}
				await ctx.db.patch('csmWebhookEvidence', id, {
					companyId,
					...(profileId ? { profileId } : {})
				});
			}
		}
		const retained = (await ctx.db.get('csmWebhookEvidence', id))!;
		if (retained.state === 'queued') {
			const jobId = await ctx.scheduler.runAfter(0, internal.csmEvidence.work, { id });
			await ctx.db.patch('csmWebhookEvidence', id, { jobId });
		}
		return { kind: 'retained', evidenceId: id };
	}
});
export const claim = internalMutation({
	args: { id: v.id('csmWebhookEvidence') },
	returns: v.union(schema.doc('csmWebhookEvidence'), v.null()),
	handler: async (ctx, { id }) => {
		const row = await ctx.db.get('csmWebhookEvidence', id);
		if (
			!row ||
			!row.hint ||
			!['queued', 'claimed'].includes(row.state) ||
			(row.dueAt ?? Infinity) > Date.now() ||
			(row.leaseUntil ?? 0) > Date.now()
		)
			return null;
		if (
			row.companyId &&
			(!(await availableCompany(ctx, row.companyId)) ||
				(row.profileId && !(await liveProfile(ctx, row.profileId))))
		) {
			await scrub(ctx, row, 'erased');
			return null;
		}
		const fields = {
			state: 'claimed' as const,
			lease: row.lease + 1,
			leaseUntil: Date.now() + RECOVERY_LEASE,
			dueAt: Date.now() + RECOVERY_LEASE
		};
		await ctx.db.patch('csmWebhookEvidence', id, fields);
		return { ...row, ...fields };
	}
});
export const associate = internalMutation({
	args: {
		id: v.id('csmWebhookEvidence'),
		generation: v.number(),
		lease: v.number(),
		reference: v.optional(v.string()),
		uid: v.optional(v.string())
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		let row = await ctx.db.get('csmWebhookEvidence', args.id);
		if (
			!row ||
			!row.hint ||
			row.generation !== args.generation ||
			row.lease !== args.lease ||
			(row.leaseUntil ?? 0) <= Date.now()
		)
			return false;
		const hint = row.hint;
		if (args.reference !== undefined) {
			const dispatchId = nativeDispatchId(args.reference);
			if (dispatchId) {
				await ctx.db.patch('csmWebhookEvidence', row._id, { dispatchId });
				row = { ...row, dispatchId };
			}
			await noteErasedInitialEvidence(ctx, args.reference);
			const locator = attemptIdFromReference(args.reference),
				id = locator ? ctx.db.normalizeId('csmBookingAttempts', locator) : null;
			const a = id ? await ctx.db.get('csmBookingAttempts', id) : null;
			if (!a || attemptReference(a) !== args.reference) {
				const exact = { ...row, hint: { ...hint, reference: args.reference } };
				if ((await notifySetupEvidence(ctx, exact)).kind === 'retained') return true;
				await scrub(ctx, row, 'erased');
				return true;
			}
			await attributeAttempt(ctx, row, a);
			return true;
		}
		return (await notifySetupEvidence(ctx, row, {}, args.uid)).kind === 'retained';
	}
});
export const finish = internalMutation({
	args: {
		id: v.id('csmWebhookEvidence'),
		generation: v.number(),
		lease: v.number(),
		disposition: recoveryDisposition
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const row = await ctx.db.get('csmWebhookEvidence', args.id);
		if (
			!row ||
			row.generation !== args.generation ||
			row.lease !== args.lease ||
			row.state !== 'claimed'
		)
			return null;
		const d = args.disposition;
		if (d.kind === 'resolved') {
			await scrub(ctx, row, 'completed');
			return null;
		}
		const failures = row.failures + (d.kind === 'retry' ? 1 : 0);
		const review = d.kind === 'review' || (d.kind === 'retry' && failures >= EVIDENCE_PASSES);
		await ctx.db.patch('csmWebhookEvidence', row._id, {
			state: review ? 'review' : 'queued',
			failures,
			leaseUntil: undefined,
			jobId: undefined,
			dueAt: review ? undefined : d.kind === 'deferred' ? d.dueAt : evidenceRetry(failures),
			reviewReason: review ? (d.kind === 'review' ? d.reason : 'evidenceHorizon') : undefined
		});
		return null;
	}
});
export const work = internalAction({
	args: { id: v.id('csmWebhookEvidence') },
	returns: v.null(),
	handler: async (ctx, { id }) => {
		const row: Evidence | null = await ctx.runMutation(internal.csmEvidence.claim, { id });
		if (!row?.hint) return null;
		let disposition: Infer<typeof recoveryDisposition> = {
			kind: 'retry',
			reason: 'incompleteAttribution'
		};
		try {
			const queue = new Set([row.hint.uid]);
			for (const uid of queue) {
				const raw = await calRead(ctx, `bookings/${encodeURIComponent(uid)}`, '2026-02-25');
				if (!object(raw) || raw.uid !== uid) break;
				const metadata = object(raw.metadata) ? raw.metadata : {};
				if (metadata.dinuCsmAttempt !== undefined) {
					if (typeof metadata.dinuCsmAttempt !== 'string') {
						disposition = { kind: 'review', reason: 'invalidNativeReference' };
						break;
					}
					const a: Doc<'csmBookingAttempts'> | null = await ctx.runQuery(
						internal.csmBookings.readReference,
						{ reference: metadata.dinuCsmAttempt }
					);
					if (!a) {
						if (
							await ctx.runMutation(internal.csmEvidence.associate, {
								id,
								generation: row.generation,
								lease: row.lease,
								reference: metadata.dinuCsmAttempt
							})
						)
							return null;
						disposition = { kind: 'resolved' };
						break;
					}
					if (!a.providerScope || !bookingInScope(raw, a.providerScope)) {
						disposition = { kind: 'review', reason: 'nativeScopeConflict' };
						break;
					}
					await ctx.runMutation(internal.csmEvidence.associate, {
						id,
						generation: row.generation,
						lease: row.lease,
						reference: metadata.dinuCsmAttempt
					});
					return null;
				}
				if (
					await ctx.runMutation(internal.csmEvidence.associate, {
						id,
						generation: row.generation,
						lease: row.lease,
						uid
					})
				)
					return null;
				if (typeof metadata.dinuCsmReference === 'string') {
					if (
						row.hint.historicalReference !== undefined &&
						row.hint.historicalReference !== metadata.dinuCsmReference
					) {
						disposition = { kind: 'review', reason: 'historicalReferenceConflict' };
						break;
					}
					const parsed = await parseCompanyReference(metadata.dinuCsmReference);
					if (!parsed || parsed.mode !== 'setup') {
						disposition = { kind: 'review', reason: 'unverifiedHistoricalReference' };
						break;
					}
					if (!parsed.profileId) {
						disposition = { kind: 'review', reason: 'historicalSourceUnbound' };
						break;
					}
					const admitted: boolean = await ctx.runAction(
						internal.csmHistoricalAppointments.importLegacy,
						{ uid }
					);
					if (
						admitted &&
						(await ctx.runMutation(internal.csmEvidence.associate, {
							id,
							generation: row.generation,
							lease: row.lease,
							uid
						}))
					)
						return null;
				}
				const b = parseSetupLocator(raw, uid);
				if (!b) break;
				for (const next of [b.fromUid, b.toUid])
					if (next && !queue.has(next)) {
						if (queue.size >= 9) {
							disposition = { kind: 'review', reason: 'attributionCap' };
							break;
						}
						queue.add(next);
					}
				if (disposition.kind === 'review') break;
			}
		} catch (error) {
			disposition = readFailure(error);
		}
		await ctx.runMutation(internal.csmEvidence.finish, {
			id,
			generation: row.generation,
			lease: row.lease,
			disposition
		});
		return null;
	}
});
export const pump = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const rows = await ctx.db
			.query('csmWebhookEvidence')
			.withIndex('by_dueAt', (q) => q.gt('dueAt', 0).lte('dueAt', Date.now()))
			.take(25);
		for (const row of rows) {
			if (!['queued', 'claimed'].includes(row.state) || (row.leaseUntil ?? 0) > Date.now())
				continue;
			const job = row.jobId ? await ctx.db.system.get('_scheduled_functions', row.jobId) : null;
			if (job && ['pending', 'inProgress'].includes(job.state.kind)) continue;
			const jobId = await ctx.scheduler.runAfter(0, internal.csmEvidence.work, { id: row._id });
			await ctx.db.patch('csmWebhookEvidence', row._id, { jobId });
		}
		return null;
	}
});
/** P3 claims freeze these IDs together with target generation/evidenceGeneration and lease. */
export async function appointmentEvidence(ctx: QueryCtx, id: Id<'csmSetupAppointments'>) {
	const appointment = await ctx.db.get('csmSetupAppointments', id);
	const dispositionedThrough = appointment?.reviewedResolution?.evidenceGeneration;
	return ctx.db
		.query('csmWebhookEvidence')
		.withIndex('by_appointmentId_and_state_and_evidenceGeneration', (q) => {
			const target = q.eq('appointmentId', id).eq('state', 'retained');
			// A committed exhaustive disposition is authoritative while its bounded cleanup drains.
			return dispositionedThrough === undefined
				? target
				: target.gt('evidenceGeneration', dispositionedThrough);
		})
		.take(26);
}
export async function completeAppointmentEvidence(
	ctx: MutationCtx,
	a: Doc<'csmSetupAppointments'>,
	ids: Id<'csmWebhookEvidence'>[],
	proofUids: string[],
	generation: number
) {
	if ((a.evidenceGeneration ?? 0) !== generation) return false;
	const rows: Evidence[] = [];
	for (const id of ids) {
		const row = await ctx.db.get('csmWebhookEvidence', id);
		if (!row || row.appointmentId !== a._id || row.state !== 'retained' || !row.hint) return false;
		if (
			(row.evidenceGeneration ?? Infinity) > generation ||
			[row.hint.uid, row.hint.previousUid, row.hint.successorHint].some(
				(uid) => uid !== undefined && !proofUids.includes(uid)
			)
		)
			return false;
		rows.push(row);
	}
	for (const row of rows) {
		await ctx.db.patch('csmWebhookEvidence', row._id, {
			state: 'completed',
			completedAt: Date.now()
		});
	}
	return true;
}
/** Dispatch can finish before ingress attribution. Transfer all still-unresolved obligations in bounded batches. */
export const adoptBookedAttempt = internalMutation({
	args: { attemptId: v.id('csmBookingAttempts') },
	returns: v.null(),
	handler: async (ctx, { attemptId }) => {
		const a = await ctx.db.get('csmBookingAttempts', attemptId);
		if (
			!a ||
			a.state !== 'booked' ||
			!(await availableCompany(ctx, a.companyId)) ||
			!(await liveProfile(ctx, a.profileId))
		)
			return null;
		const rows = await ctx.db
			.query('csmWebhookEvidence')
			.withIndex('by_attemptId_and_state', (q) =>
				q.eq('attemptId', attemptId).eq('state', 'retained')
			)
			.take(25);
		for (const row of rows) {
			if (a.mode === 'setup') {
				const result = await notifySetupEvidence(ctx, row, { attemptId });
				if (result.kind !== 'retained')
					await ctx.db.patch('csmWebhookEvidence', row._id, {
						state: 'review',
						reviewReason: 'appointmentUnavailable',
						dueAt: undefined
					});
			} else
				await ctx.db.patch('csmWebhookEvidence', row._id, {
					state: 'completed',
					completedAt: Date.now()
				});
		}
		if (rows.length === 25)
			await ctx.scheduler.runAfter(0, internal.csmEvidence.adoptBookedAttempt, { attemptId });
		return null;
	}
});
export const cleanup = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const rows = await ctx.db
			.query('csmWebhookEvidence')
			.withIndex('by_completedAt', (q) =>
				q.gt('completedAt', 0).lt('completedAt', Date.now() - 30 * 86_400_000)
			)
			.take(25);
		for (const row of rows) {
			if (!['completed', 'erased'].includes(row.state)) continue;
			// Keep completed identities throughout a target's lifetime/review; duplicates never rearm it.
			if (row.attemptId && (await ctx.db.get('csmBookingAttempts', row.attemptId))) {
				await ctx.db.patch('csmWebhookEvidence', row._id, { completedAt: Date.now() });
				continue;
			}
			if (row.appointmentId && (await ctx.db.get('csmSetupAppointments', row.appointmentId))) {
				await ctx.db.patch('csmWebhookEvidence', row._id, { completedAt: Date.now() });
				continue;
			}
			if (
				row.dispatchId &&
				(await ctx.db
					.query('csmErasedInitialGuards')
					.withIndex('by_dispatchId', (q) => q.eq('dispatchId', row.dispatchId))
					.first())
			) {
				await ctx.db.patch('csmWebhookEvidence', row._id, { completedAt: Date.now() });
				continue;
			}
			await ctx.db.delete('csmWebhookEvidence', row._id);
		}
		return null;
	}
});
