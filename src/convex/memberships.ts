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
