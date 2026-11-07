/** Temporary v1 authoring API. New callers use playbookItems. */
import { v, type Infer } from 'convex/values';
import { legacyPlaybook as convertItem } from '../lib/contract/legacy-values';
import type { PlaybookItem } from '../lib/playbook/model';
import { api } from './_generated/api';
import { mutation } from './_generated/server';
import { legacyItemView, legacyPlaybook, legacyStoredItem } from './legacyViews';
const conflict = v.object({ status: v.literal('conflict'), item: legacyStoredItem });
const saveResult = v.union(
	v.object({ status: v.literal('saved'), item: legacyStoredItem }),
	conflict,
	v.object({ status: v.literal('rejected'), message: v.string() }),
	v.object({ status: v.literal('missing') })
);
export const savePlaybookItem = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.optional(v.id('playbookItems')),
		item: legacyPlaybook,
		expectedRevision: v.number(),
		operationId: v.string()
	},
	returns: saveResult,
	handler: async (ctx, { item, expectedRevision, ...args }): Promise<Infer<typeof saveResult>> => {
		const result = await ctx.runMutation(api.playbookItems.savePlaybookItem, {
			...args,
			item: convertItem(item) as PlaybookItem,
			expectedContentRevision: expectedRevision
		});
		if (result.status === 'saved' || result.status === 'conflict')
			return { status: result.status, item: legacyItemView(result.item) };
		return result;
	}
});
const deleteResult = v.union(v.object({ status: v.literal('deleted') }), conflict);
export const deletePlaybookItem = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('playbookItems'),
		expectedRevision: v.number()
	},
	returns: deleteResult,
	handler: async (ctx, { expectedRevision, ...args }): Promise<Infer<typeof deleteResult>> => {
		const result = await ctx.runMutation(api.playbookItems.deletePlaybookItem, {
			...args,
			expectedContentRevision: expectedRevision
		});
		return result.status === 'conflict'
			? { status: result.status, item: legacyItemView(result.item) }
			: { status: result.status };
	}
});
