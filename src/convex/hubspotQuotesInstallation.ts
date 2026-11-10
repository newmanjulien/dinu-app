import { ConvexError, v } from 'convex/values';
import { mutation, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { requireMembership } from './auth';

export function quoteInstallationFor(ctx: QueryCtx, companyId: Id<'company'>) {
	return ctx.db
		.query('hubspotQuoteInstallations')
		.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
		.unique();
}

/** Epoch invalidation fences both pending OAuth callbacks and workers in one transaction. */
export async function disableQuotes(ctx: MutationCtx, companyId: Id<'company'>) {
	const row = await quoteInstallationFor(ctx, companyId);
	if (row)
		await ctx.db.patch('hubspotQuoteInstallations', row._id, {
			enabled: false,
			epoch: row.epoch + 1
		});
}

export const uninstall = mutation({
	args: {
		membershipId: v.id('memberships'),
		installationId: v.id('hubspotQuoteInstallations'),
		epoch: v.number()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		if (access.membership.role !== 'admin')
			throw new ConvexError('Only admins can uninstall HubSpot Quotes.');
		const row = await quoteInstallationFor(ctx, access.companyId);
		if (!row || row._id !== args.installationId || row.epoch !== args.epoch) {
			if (row && !row.enabled && row._id === args.installationId) return null;
			throw new ConvexError('HubSpot Quotes changed. Reload to see its status.');
		}
		await disableQuotes(ctx, access.companyId);
		return null;
	}
});
