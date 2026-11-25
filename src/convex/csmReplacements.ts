import { ConvexError, v, type Infer } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { liveProfile, type CompanyAccess } from './auth';
import { permissionsForRole } from './permissions';
import { setupReplacement } from './csmBookingValidators';
import { safeFailedEvidence } from './csmAttemptState';
import { validBookingUid } from './csmCal';
import { retireSupersededSetupAppointment } from './csmSetupLifecycle';
import { readConfirmedSetupBooking, resolveSetupBooking } from './csmSetupState';

export type Replacement = Infer<typeof setupReplacement>;
type Appointment = Doc<'csmSetupAppointments'>;
type Attempt = Doc<'csmBookingAttempts'>;
export const replacementProgress = v.object({
	state: v.union(
		v.literal('ready'),
		v.literal('in-progress'),
		v.literal('uncertain'),
		v.literal('completed'),
		v.literal('unavailable')
	),
	// A private receipt locator is returned only to its owner.
	attemptId: v.optional(v.id('csmBookingAttempts'))
});
export function sameReplacement(a: Replacement | undefined, b: Replacement | undefined) {
	return a?.appointmentId === b?.appointmentId && a?.currentUid === b?.currentUid;
}
export function replacementAware(a: Appointment) {
	return !!(a.replacementAttemptId || a.superseded || a.erasedReplacementUncertain);
}
export async function replacementSource(ctx: QueryCtx, owner: CompanyAccess, target: Replacement) {
	if (
		!permissionsForRole(owner.membership.role, owner.isOwner).manageTemplate ||
		owner.company.templateSourceId ||
		!validBookingUid(target.currentUid)
	)
		throw new ConvexError('This setup call is unavailable.');
	const booking = await resolveSetupBooking(ctx, owner.company);
	const source = booking.kind === 'cancelled' ? booking.appointment : null;
	if (
		!source ||
		source._id !== target.appointmentId ||
		source.currentUid !== target.currentUid ||
		source.companyId !== owner.companyId ||
		!(await liveProfile(ctx, source.profileId))
	)
		throw new ConvexError('This setup call is unavailable.');
	return source;
}
/** Missing receipts and historical failures without noncreation proof must fail closed. */
export async function replacementState(ctx: QueryCtx, source: Appointment) {
	if (source.superseded) return { state: 'completed' as const };
	if (source.erasedReplacementUncertain) return { state: 'uncertain' as const };
	if (source.replacementAttemptId) {
		const attempt = await ctx.db.get('csmBookingAttempts', source.replacementAttemptId);
		if (
			!attempt ||
			attempt.companyId !== source.companyId ||
			attempt.mode !== 'setup' ||
			attempt.replacement?.appointmentId !== source._id
		)
			return { state: 'uncertain' as const };
		if (attempt.state === 'booked' && attempt.confirmation)
			return { state: 'completed' as const, attempt };
		if (attempt.state === 'queued' || attempt.state === 'submitting')
			return { state: 'in-progress' as const, attempt };
		if (!safeFailedEvidence(attempt)) return { state: 'uncertain' as const, attempt };
	}
	return {
		state:
			source.status === 'cancelled' &&
			(await readConfirmedSetupBooking(ctx, source))?.status === 'cancelled'
				? ('ready' as const)
				: ('unavailable' as const)
	};
}
export async function sharedReplacement(
	ctx: QueryCtx,
	owner: CompanyAccess,
	target: Replacement
): Promise<Infer<typeof replacementProgress>> {
	// Rendering a frozen historical target is independent from new-creation eligibility.
	const source = await ctx.db.get('csmSetupAppointments', target.appointmentId);
	if (
		!source ||
		!permissionsForRole(owner.membership.role, owner.isOwner).manageTemplate ||
		source.companyId !== owner.companyId ||
		!validBookingUid(target.currentUid)
	)
		return { state: 'unavailable' };
	const progress = await replacementState(ctx, source);
	return {
		state:
			source.currentUid !== target.currentUid &&
			!('attempt' in progress && sameReplacement(progress.attempt?.replacement, target))
				? 'unavailable'
				: progress.state,
		...('attempt' in progress &&
		progress.attempt?.membershipId === owner.membership._id &&
		progress.attempt.profileId === owner.profile._id &&
		sameReplacement(progress.attempt.replacement, target)
			? { attemptId: progress.attempt._id }
			: {})
	};
}
/** Constant-work reconciliation before private receipt erasure, including a running sender. */
export async function eraseReplacementAttempt(ctx: MutationCtx, attempt: Attempt) {
	if (!attempt.replacement) return;
	const source = await ctx.db.get('csmSetupAppointments', attempt.replacement.appointmentId);
	if (
		!source ||
		source.companyId !== attempt.companyId ||
		source.replacementAttemptId !== attempt._id
	)
		return;
	const succeeded = attempt.state === 'booked' && !!attempt.confirmation;
	const safe = attempt.state === 'queued' || safeFailedEvidence(attempt);
	if (succeeded) await retireSupersededSetupAppointment(ctx, source);
	await ctx.db.patch('csmSetupAppointments', source._id, {
		replacementAttemptId: undefined,
		...(!succeeded && !safe ? { erasedReplacementUncertain: true } : {})
	});
}
