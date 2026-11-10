import { v } from 'convex/values';
import { reviewCompletion, selections, storedContract } from './contractValidators';
import schema from './schema';

export { selections };
const workBlock = v.optional(
	v.union(v.null(), v.literal('association-required'), v.literal('deal-unavailable'))
);

export const contractCard = schema
	.doc('savedContracts')
	.pick('_id', '_creationTime', 'buyerCompanyName', 'savedAt', 'hubspot')
	.extend({
		workBlock,
		creator: v.object({ name: v.string(), avatarUrl: v.union(v.string(), v.null()) })
	});
export const contractState = storedContract
	.pick('buyerCompanyName', 'applications', 'editRevision', 'reviewGeneration', 'hubspot')
	.extend({
		workBlock,
		reviewCompletion: v.union(reviewCompletion, v.null()),
		stateVersion: v.number(),
		lastOperationId: v.union(v.string(), v.null())
	});
// Live reads include the immutable version reference, never the template content.
export const contractMetadata = contractState.extend(
	schema
		.doc('savedContracts')
		.pick('_id', '_creationTime', 'companyId', 'creatorId', 'templateVersionId', 'savedAt').fields
);
export const liveContractMetadata = contractMetadata.extend({
	workBlock: v.union(v.null(), v.literal('association-required'), v.literal('deal-unavailable'))
});
export const exportRequest = v.object({
	membershipId: v.id('memberships'),
	id: v.id('savedContracts'),
	expectedEditRevision: v.number()
});
export const saveResult = v.union(
	v.object({ status: v.literal('saved'), state: contractState }),
	v.object({ status: v.literal('conflict'), state: contractState }),
	v.object({ status: v.literal('deleted') })
);
