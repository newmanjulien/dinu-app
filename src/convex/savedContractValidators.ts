import { v } from 'convex/values';
import { baselineBlock } from './sourceValidators';
import schema from './schema';
import { historicalItem } from './playbookValidators';
import { selections, concessionReviews } from './contractValidators';

export { selections };
export const snapshot = v.object({
	blockCount: v.number(),
	itemCount: v.number(),
	blocks: v.array(baselineBlock),
	items: v.array(historicalItem)
});
export const contractCard = schema
	.doc('savedContracts')
	.pick('_id', 'companyName', 'savedAt')
	.extend({
		creator: v.object({ name: v.string(), avatarUrl: v.union(v.string(), v.null()) })
	});
export const contractState = v.object({
	companyName: v.string(),
	selectedConcessions: selections,
	reviews: concessionReviews,
	revision: v.number(),
	lastOperationId: v.union(v.string(), v.null())
});
// Live reads include the immutable version reference, never the template content.
export const contractMetadata = contractState.extend(
	schema
		.doc('savedContracts')
		.pick('_id', '_creationTime', 'companyId', 'creatorId', 'templateVersionId', 'savedAt').fields
);
export const exportRequest = v.object({
	membershipId: v.id('memberships'),
	id: v.id('savedContracts'),
	expectedRevision: v.number()
});
export const saveResult = v.union(
	v.object({ status: v.literal('saved'), state: contractState }),
	v.object({ status: v.literal('conflict'), state: contractState }),
	v.object({ status: v.literal('deleted') })
);
