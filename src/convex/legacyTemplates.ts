import { v, type Infer } from 'convex/values';
import { api } from './_generated/api';
import { query } from './_generated/server';
import { legacyBlockView, legacyItemView, legacySnapshot } from './legacyViews';

/** Temporary v1 content view. New callers use templates.content. */
export const version = query({
	args: { membershipId: v.id('memberships'), versionId: v.id('templateVersions') },
	returns: legacySnapshot,
	handler: async (ctx, args): Promise<Infer<typeof legacySnapshot>> => {
		const content = await ctx.runQuery(api.templates.content, args);
		return {
			...content,
			blocks: content.blocks.map(legacyBlockView),
			items: content.items.map((item) => legacyItemView(item))
		};
	}
});
