/** Frozen baseline wire view for already-open v1 clients. */
import { v, type Infer } from 'convex/values';
import { api } from './_generated/api';
import { query } from './_generated/server';
import { legacyBlock, legacyBlockView } from './legacyViews';

export const getBlocks = query({
	args: { membershipId: v.id('memberships') },
	returns: v.array(legacyBlock),
	handler: async (ctx, args): Promise<Infer<typeof legacyBlock>[]> =>
		(await ctx.runQuery(api.baselines.blocks, args)).map(legacyBlockView)
});
