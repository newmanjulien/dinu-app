/** Legacy scheduled callbacks only. New code uses templateUploads. */
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { terminologyTransition } from './terminologyMaintenance';

// Old IDs cannot identify the copied source. The canonical sweeper owns expiration.
export const expire = internalMutation({
	args: { baselineId: v.id('baselines') },
	returns: v.null(),
	handler: async (ctx) => {
		if (!terminologyTransition)
			await ctx.scheduler.runAfter(0, internal.templateUploads.expirePending, {});
		return null;
	}
});
export const expirePrepared = internalMutation({
	args: {
		state: v.optional(v.union(v.literal('prepared'), v.literal('deleting'))),
		cursor: v.optional(v.union(v.string(), v.null()))
	},
	returns: v.null(),
	handler: async (ctx) => {
		if (!terminologyTransition)
			await ctx.scheduler.runAfter(0, internal.templateUploads.expirePending, {});
		return null;
	}
});
