import { v, type Infer } from 'convex/values';
import { api } from './_generated/api';
import { query } from './_generated/server';
import { legacyItemView, legacyStoredItem } from './legacyViews';

/** Temporary v1 list view. New callers use playbookItems.current. */
export const list = query({
	args: { membershipId: v.id('memberships') },
	returns: v.array(legacyStoredItem),
	handler: async (ctx, args): Promise<Infer<typeof legacyStoredItem>[]> =>
		(await ctx.runQuery(api.playbookItems.current, args)).map((item) => legacyItemView(item))
});
