import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import { attemptReference } from './csmHistory';
import { validProviderScope } from './csmIdentity';
import { CalRateLimitError } from './csmProviderFailures';

export const RECOVERY_LEASE = 150_000;
export const EVIDENCE_PASSES = 10;
export const recoveryDisposition = v.union(
	v.object({ kind: v.literal('resolved') }),
	v.object({ kind: v.literal('retry'), reason: v.string() }),
	v.object({ kind: v.literal('deferred'), dueAt: v.number(), reason: v.string() }),
	v.object({ kind: v.literal('review'), reason: v.string() })
);
export function evidenceRetry(failures: number, now = Date.now()) {
	return now + Math.min(60_000 * 2 ** Math.min(failures, 10), 6 * 60 * 60_000);
}
export function readFailure(error: unknown) {
	return error instanceof CalRateLimitError
		? { kind: 'deferred' as const, dueAt: Date.now() + error.retryAfter, reason: 'quota' }
		: { kind: 'retry' as const, reason: 'provider' };
}
/** Shared with bounded historical conversion. Never grants creation permission or resets history. */
export function recoveryEnrollment(a: Doc<'csmBookingAttempts'>, now = Date.now()) {
	if (a.state !== 'unknown') return { kind: 'inapplicable' as const };
	if (a.recoveryReview || a.reviewRequired)
		return { kind: 'review' as const, reason: a.recoveryReview ?? 'historicalReview' };
	if (!validProviderScope(a.providerScope) || !attemptReference(a) || !a.attendeeEmail)
		return { kind: 'review' as const, reason: 'missingOriginalProof' };
	if (
		a.recoveryFailures !== undefined &&
		(!Number.isSafeInteger(a.recoveryFailures) || a.recoveryFailures < 0)
	)
		return { kind: 'review' as const, reason: 'invalidRecoveryHistory' };
	if (a.recoveryDue !== undefined)
		return { kind: 'eligible' as const, dueAt: Math.max(a.recoveryDue, a.recoveryLeaseUntil ?? 0) };
	if ((a.recoveryFailures ?? 0) >= EVIDENCE_PASSES)
		return { kind: 'review' as const, reason: 'evidenceHorizon' };
	return {
		kind: 'eligible' as const,
		dueAt: Math.max(a.recoveryDue ?? now, a.recoveryLeaseUntil ?? 0)
	};
}
export async function enrollAttemptRecovery(ctx: MutationCtx, a: Doc<'csmBookingAttempts'>) {
	const enrollment = recoveryEnrollment(a);
	if (enrollment.kind === 'inapplicable') return enrollment;
	if (enrollment.kind === 'review') {
		await ctx.db.patch('csmBookingAttempts', a._id, {
			recoveryReview: enrollment.reason,
			recoveryDue: undefined
		});
		return enrollment;
	}
	if (a.recoveryDue !== undefined) return enrollment;
	const recoveryJobId = await ctx.scheduler.runAfter(
		Math.max(0, enrollment.dueAt - Date.now()),
		internal.csmBookings.recoverAttempt,
		{ attemptId: a._id }
	);
	await ctx.db.patch('csmBookingAttempts', a._id, {
		recoveryDue: enrollment.dueAt,
		recoveryJobId,
		recoveryGeneration: a.recoveryGeneration ?? 0,
		recoveryFailures: a.recoveryFailures ?? 0
	});
	return enrollment;
}
