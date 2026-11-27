import { getFunctionName } from 'convex/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { env, internalMutation } from './_generated/server';
import { recoveryRows, recoveryStates } from './emailDeliveries';

/** Safety net for missed jobs. Due-row writes own normal scheduling. */
export const sweep = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const now = Date.now();
		const probes = [
			{
				rows: ctx.db
					.query('csmMeetingPreparations')
					.withIndex('by_dueAt', (q) => q.gt('dueAt', 0).lte('dueAt', now)),
				fn: internal.csmMeetingPreparation.pump
			},
			{
				rows: ctx.db
					.query('csmBookingAttempts')
					.withIndex('by_recoveryDue', (q) => q.gt('recoveryDue', 0).lte('recoveryDue', now)),
				fn: internal.csmBookings.repairRecovery
			},
			{
				rows: ctx.db
					.query('csmWebhookEvidence')
					.withIndex('by_dueAt', (q) => q.gt('dueAt', 0).lte('dueAt', now)),
				fn: internal.csmEvidence.pump
			},
			{
				rows: ctx.db
					.query('csmErasedInitialGuards')
					.withIndex('by_observeAt', (q) => q.gt('observeAt', 0).lte('observeAt', now)),
				fn: internal.csmErasureGuards.pump
			},
			{
				rows: ctx.db
					.query('csmSetupAppointments')
					.withIndex('by_repairAt', (q) => q.gt('repairAt', 0).lte('repairAt', now)),
				fn: internal.csmSetupAppointments.repairDue
			},
			{
				rows: ctx.db
					.query('hubspotRemovals')
					.withIndex('by_done_and_dueAt', (q) => q.eq('done', false).lte('dueAt', now)),
				fn: internal.hubspotUninstall.resume
			},
			{
				rows: ctx.db
					.query('hubspotAccountRemovals')
					.withIndex('by_dueAt', (q) => q.gte('dueAt', 0).lte('dueAt', now)),
				fn: internal.hubspotUninstall.resume
			},
			...(['queued', 'dispatched', 'verifying'] as const).map((state) => ({
				rows: ctx.db
					.query('hubspotQuotePushes')
					.withIndex('by_state_and_dueAt', (q) =>
						q.eq('state', state).gt('dueAt', 0).lte('dueAt', now)
					),
				fn: internal.hubspotQuotes.pump
			})),
			...(env.HUBSPOT_ENABLED === 'true' && env.HUBSPOT_DELIVERY_ENABLED === 'true'
				? (['pending', 'uncertain', 'working', 'blocked'] as const).map((status) => ({
						rows: ctx.db
							.query('hubspotEvents')
							.withIndex('by_status_and_dueAt', (q) => q.eq('status', status).lte('dueAt', now)),
						fn: internal.hubspotDelivery.pump
					}))
				: [])
		];
		const scheduled = new Set<string>();
		for (const { rows, fn } of probes) {
			const name = getFunctionName(fn);
			if (scheduled.has(name)) continue;
			try {
				if (await rows.first()) {
					await ctx.scheduler.runAfter(0, fn, {});
					scheduled.add(name);
				}
			} catch (error) {
				console.error('Unable to discover due recovery work', name, error);
			}
		}
		return null;
	}
});

/** Bounded idle probes; each nonempty family runs in its own scheduled transaction. */
export const resume = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const probes = [
			{
				rows: ctx.db.query('deletedUsers').withIndex('by_complete', (q) => q.eq('complete', false)),
				fn: internal.accountDeletion.resume,
				args: {}
			},
			{
				rows: ctx.db
					.query('companyDeletions')
					.withIndex('by_status_and_requestedAt', (q) => q.eq('status', 'cleaning')),
				fn: internal.companyDeletion.resume,
				args: {}
			},
			{
				rows: ctx.db.query('contractCleanups').withIndex('by_creation_time'),
				fn: internal.contractCleanup.resume,
				args: {}
			},
			...recoveryStates.map((state) => ({
				rows: recoveryRows(ctx, state),
				fn: internal.emailDeliveries.resume,
				args: { state }
			})),
			{
				rows: ctx.db
					.query('companyDeletions')
					.withIndex('by_status_and_requestedAt', (q) => q.eq('status', 'deleting')),
				fn: internal.clerk.reconcileCompanies,
				args: {}
			}
		];
		for (const { rows, fn, args } of probes) {
			try {
				if (await rows.first()) await ctx.scheduler.runAfter(0, fn, args);
			} catch (error) {
				console.error('Unable to discover recovery work', getFunctionName(fn), error);
			}
		}
		return null;
	}
});
