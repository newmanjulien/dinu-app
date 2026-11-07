/** Existing Node actions can finish across a backend/frontend release boundary. */
import { v, type Infer } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation, internalQuery } from './_generated/server';
import {
	legacyBlock,
	legacyBlockView,
	legacyHistoricalItem,
	legacyItemView,
	legacyStoredContract,
	legacyContractView
} from './legacyViews';

const request = v.object({
	membershipId: v.id('memberships'),
	id: v.id('savedContracts'),
	expectedRevision: v.number()
});
const review = v.object({
	itemId: v.id('playbookItems'),
	concessionId: v.string(),
	lifecycle: v.string()
});
const sourceResult = v.object({
	contract: legacyStoredContract,
	blocks: v.array(legacyBlock),
	items: v.array(legacyHistoricalItem),
	requiredReviews: v.array(review)
});
export const source = internalQuery({
	args: request.fields,
	returns: sourceResult,
	handler: async (ctx, { expectedRevision, ...args }): Promise<Infer<typeof sourceResult>> => {
		const result = await ctx.runQuery(internal.contractExports.capture, {
			...args,
			expectedEditRevision: expectedRevision
		});
		return {
			...result,
			contract: legacyContractView(result.contract),
			blocks: result.blocks.map(legacyBlockView),
			items: result.items.map((item) => legacyItemView(item)),
			requiredReviews: result.requiredReviews.map(({ applicationId, ...selection }) => ({
				...selection,
				lifecycle: applicationId
			}))
		};
	}
});
export const finalize = internalMutation({
	args: request.extend({
		templateVersionId: v.id('templateVersions'),
		requiredReviews: v.array(review),
		fileId: v.id('_storage')
	}).fields,
	returns: v.string(),
	handler: (ctx, { expectedRevision, requiredReviews, ...args }): Promise<string> =>
		ctx.runMutation(internal.contractExports.authorizeDownload, {
			...args,
			expectedEditRevision: expectedRevision,
			requiredReviews: requiredReviews.map(({ lifecycle, ...selection }) => ({
				...selection,
				applicationId: lifecycle
			}))
		})
});
