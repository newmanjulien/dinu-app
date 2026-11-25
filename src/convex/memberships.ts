import { v } from 'convex/values';
import { mutation } from './_generated/server';
import { requireMembership } from './auth';
import { role } from './permissions';

export const setRole = mutation({
	args: { role },
	returns: v.null(),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx);
		if (access.membership.role !== args.role)
			await ctx.db.patch('memberships', access.membershipId, { role: args.role });
		return null;
	}
});

/** The support widget's size is a personal choice that follows the member across devices. */
export const setSupportWidgetCollapsed = mutation({
	args: { membershipId: v.id('memberships'), collapsed: v.boolean() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const { membership, membershipId } = await requireMembership(ctx, args.membershipId);
		if (membership.supportWidgetCollapsed !== args.collapsed)
			await ctx.db.patch('memberships', membershipId, { supportWidgetCollapsed: args.collapsed });
		return null;
	}
});
