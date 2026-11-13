import { v } from 'convex/values';
import { contextCompletion, selections } from './contractValidators';
import { playbookState } from '../lib/contract/changes';
import { hubspotLink } from './hubspotValidators';
import { sourceExpectation } from './contractSourceValidators';
export { selections };
const workBlock = v.optional(
	v.union(v.null(), v.literal('association-required'), v.literal('deal-unavailable'))
);
export const contractCard = v.object({
	_id: v.id('savedContracts'),
	_creationTime: v.number(),
	title: v.string(),
	savedAt: v.number(),
	hasUnreadComment: v.boolean(),
	hubspot: v.optional(hubspotLink),
	workBlock,
	creator: v.object({ name: v.string(), avatarUrl: v.union(v.string(), v.null()) })
});
export const contractState = v.object({
	title: v.string(),
	documentId: v.id('contractDocuments'),
	documentRevision: v.number(),
	stateRevision: v.number(),
	playbookReviewIdentity: v.string(),
	buyerLinkReviewIdentity: v.string(),
	playbook: v.array(playbookState),
	hubspot: v.optional(hubspotLink),
	workBlock,
	playbookCompletion: v.union(contextCompletion, v.null()),
	buyerLinkCompletion: v.union(contextCompletion, v.null()),
	lastOperationId: v.union(v.string(), v.null())
});
export const contractMetadata = contractState.extend({
	_id: v.id('savedContracts'),
	_creationTime: v.number(),
	companyId: v.id('company'),
	creatorId: v.id('profiles'),
	templateVersionId: v.id('templateVersions'),
	savedAt: v.number()
});
export const liveContractMetadata = contractMetadata.extend({
	buyerName: v.union(v.string(), v.null()),
	workBlock: v.union(v.null(), v.literal('association-required'), v.literal('deal-unavailable'))
});
export const exportRequest = v.object({
	expectedSource: sourceExpectation,
	membershipId: v.id('memberships'),
	id: v.id('savedContracts')
});
export const saveResult = v.union(
	v.object({ status: v.literal('saved'), state: contractState }),
	v.object({ status: v.literal('conflict'), state: contractState }),
	v.object({ status: v.literal('preparing'), operationId: v.string() }),
	v.object({ status: v.literal('deleted') })
);
