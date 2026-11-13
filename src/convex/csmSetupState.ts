import type { Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { liveProfile } from './auth';
import { readHistoricalConfirmedBooking } from './csmHistory';
import { confirmedSetupBooking, setupCallView } from './csmSetupValidators';

type Appointment = Doc<'csmSetupAppointments'>;
export type ConfirmedSetupBooking = Infer<typeof confirmedSetupBooking>;

/** Canonical facts are preferred; old rows cross the isolated historical decoder. */
export async function readConfirmedSetupBooking(ctx: QueryCtx, a: Appointment) {
	return a.confirmedBooking ?? readHistoricalConfirmedBooking(ctx, a);
}

export type SetupBookingState =
	| { kind: 'initial' }
	| { kind: 'confirmed'; appointment: Appointment; confirmed: ConfirmedSetupBooking }
	| { kind: 'cancelled'; appointment: Appointment; confirmed: ConfirmedSetupBooking }
	| { kind: 'unavailable' };

/** Qualification follows owned decisive facts, never presentation visibility or the clock. */
export async function resolveSetupBooking(
	ctx: QueryCtx,
	company: Doc<'company'>
): Promise<SetupBookingState> {
	if (!company.setupAppointmentId) return { kind: 'initial' };
	const appointment = await ctx.db.get('csmSetupAppointments', company.setupAppointmentId);
	if (
		!appointment ||
		appointment.companyId !== company._id ||
		appointment.superseded ||
		!(await liveProfile(ctx, appointment.profileId))
	)
		return { kind: 'unavailable' };
	const confirmed = await readConfirmedSetupBooking(ctx, appointment);
	return confirmed?.status === 'accepted'
		? { kind: 'confirmed', appointment, confirmed }
		: confirmed?.status === 'cancelled'
			? { kind: 'cancelled', appointment, confirmed }
			: { kind: 'unavailable' };
}

/** Presentation exposes no provider locators, private receipts, or synchronization state. */
export function setupCallFor(booking: SetupBookingState | null): Infer<typeof setupCallView> {
	if (!booking || !('confirmed' in booking)) return null;
	return {
		state: booking.kind === 'confirmed' ? 'scheduled' : 'cancelled',
		start: booking.confirmed.start,
		end: booking.confirmed.end
	};
}

/** Three bounded index ranges also serialize independent admins' initial admission. */
export async function pendingInitialSetup(
	ctx: QueryCtx,
	companyId: Id<'company'>,
	exclude?: Id<'csmBookingAttempts'>
) {
	for (const state of ['queued', 'submitting', 'unknown'] as const) {
		const rows = await ctx.db
			.query('csmBookingAttempts')
			.withIndex('by_companyId_and_mode_and_state', (q) =>
				q.eq('companyId', companyId).eq('mode', 'setup').eq('state', state)
			)
			.take(exclude ? 2 : 1);
		const other = rows.find((row) => row._id !== exclude);
		if (other) return other;
	}
	return null;
}

/** Deletion clears only the current reference; historical rows cannot clear a newer booking. */
export async function clearSetupAppointment(ctx: MutationCtx, appointment: Appointment) {
	const company = await ctx.db.get('company', appointment.companyId);
	if (company?.setupAppointmentId === appointment._id)
		await ctx.db.patch('company', company._id, { setupAppointmentId: undefined });
}

/** Compatible chain merges transfer the canonical reference before removing any loser. */
export async function transferSetupAppointment(
	ctx: MutationCtx,
	rows: Appointment[],
	survivor: Appointment
) {
	const company = await ctx.db.get('company', survivor.companyId);
	const current = rows.find((row) => row._id === company?.setupAppointmentId);
	if (!company || !current || current.companyId !== company._id || current._id === survivor._id)
		return null;
	const confirmed = await readConfirmedSetupBooking(ctx, current);
	if (confirmed)
		await ctx.db.patch('csmSetupAppointments', survivor._id, {
			confirmedBooking: confirmed,
			bookingConfirmation: undefined
		});
	await ctx.db.patch('company', company._id, { setupAppointmentId: survivor._id });
	return confirmed;
}
