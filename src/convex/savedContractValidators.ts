import { v } from 'convex/values';
import { contractConcession, contractReview, workBlock } from '../lib/contract/changes';
import { requestDeliveryStatus, selections } from './contractValidators';
import { quoteSummary } from './hubspotQuoteValidators';
import { hubspotLink } from './hubspotValidators';

export { selections };

export const contractCard = v.object({
	templateVersionId: v.id('templateVersions'),
	_id: v.id('savedContracts'),
	_creationTime: v.number(),
	title: v.string(),
	savedAt: v.number(),
	hasUnreadComment: v.boolean(),
	buyerLinkToken: v.union(v.string(), v.null()),
	hubspot: v.optional(hubspotLink),
	workBlock: v.optional(workBlock),
	creator: v.object({ name: v.string(), avatarUrl: v.union(v.string(), v.null()) })
});

export const contractBuyerLink = v.object({
	id: v.id('buyerLinks'),
	token: v.string(),
	createdAt: v.number(),
	contentRevision: v.number(),
	concessions: v.record(v.id('playbookItems'), v.string())
});

export const contractState = v.object({
	title: v.string(),
	stateRevision: v.number(),
	metadataRevision: v.number(),
	concessions: v.array(contractConcession),
	review: contractReview,
	hubspot: v.optional(hubspotLink),
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
	workBlock,
	requestDelivery: v.union(requestDeliveryStatus, v.null()),
	buyerLink: v.union(contractBuyerLink, v.null()),
	hasUnreadComment: v.boolean(),
	latestQuote: v.union(quoteSummary, v.null())
});

export const wordExportResult = v.object({
	url: v.string(),
	filename: v.string()
});

export const saveResult = v.union(
	v.object({ status: v.literal('saved'), state: contractState }),
	v.object({ status: v.literal('conflict'), state: contractState }),
	v.object({ status: v.literal('deleted') })
);
