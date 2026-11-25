import { getFunctionName } from 'convex/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation } from './_generated/server';
import { recoveryRows, recoveryStates } from './emailDeliveries';

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
			{
				rows: ctx.db.query('buyerLinkShowingCleanups').withIndex('by_creation_time'),
				fn: internal.buyerLinkShowingCleanup.resume,
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
