import { contractItemId } from '../lib/contract/item-identity';
import { v } from 'convex/values';

import { hubspotLink } from './hubspotValidators';
import { changeKind } from '../lib/contract/changes';
export { contractRenderTransport } from '../lib/document/contract-document-validators';

export const selections = v.record(contractItemId, v.string());
export const reviewCompletion = v.union(
	v.object({
		kind: v.literal('awaitingConfirmation'),
		reviewerId: v.id('profiles')
	}),
	v.object({
		kind: v.literal('queued'),
		deliveryId: v.id('emailDeliveries')
	})
);
export const contractBuyer = v.union(
	v.object({ kind: v.literal('manual') }),
	v.object({
		kind: v.literal('hubspot'),
		company: v.union(v.object({ id: v.string(), name: v.string() }), v.null())
	})
);
export const contextCompletion = v.object({
	reviewIdentity: v.string(),
	completion: reviewCompletion
});
export const reviewGroup = v.object({
	identity: v.string(),
	completion: v.optional(contextCompletion)
});
export const contractReviews = v.object({
	playbook: reviewGroup,
	buyerLink: reviewGroup
});
/** documentId is null only within the atomic root/document creation transaction. */
export const contractRoot = v.object({
	companyId: v.id('company'),
	creatorId: v.id('profiles'),
	templateVersionId: v.id('templateVersions'),
	title: v.string(),
	buyer: contractBuyer,
	documentId: v.union(v.id('contractDocuments'), v.null()),
	documentRevision: v.number(),
	stateRevision: v.number(),
	playbookSelectionCount: v.number(),
	playbookReviewCount: v.number(),
	playbookPendingCount: v.number(),
	playbookDeclinedCount: v.number(),
	reviews: contractReviews,
	savedAt: v.number(),
	quoteRequests: v.optional(
		v.object({
			watermark: v.number(),
			latest: v.optional(v.object({ requestedAt: v.number(), pushId: v.id('hubspotQuotePushes') }))
		})
	),
	lastOperation: v.optional(v.object({ id: v.string(), callerId: v.id('profiles') }))
});
export const storedContractHubspotAssociation = hubspotLink.extend({
	companyId: v.id('company'),
	contractId: v.id('savedContracts')
});
export const buyerRefreshTiming = v.object({
	attempt: v.string(),
	leaseUntil: v.number(),
	dueAt: v.number(),
	installedAt: v.number(),
	capabilities: v.string(),
	suppressed: v.boolean()
});
export const contractBuyerRefresh = buyerRefreshTiming.extend({
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	associationId: v.id('contractHubspotAssociations'),
	connectionId: v.id('hubspotConnections'),
	accountId: v.string(),
	dealId: v.string(),
	generation: v.number()
});
export const storedContract = contractRoot;
export const approvalRequest = v.object({
	id: v.string(),
	context: changeKind,
	identity: v.string(),
	cutoff: v.number(),
	title: v.string(),
	count: v.number(),
	coveredPendingCount: v.number(),
	unsubmittedPendingCount: v.number(),
	active: v.boolean(),
	status: v.union(
		v.literal('sending'),
		v.literal('sent'),
		v.literal('failed'),
		v.literal('uncertain')
	),
	requestedAt: v.number(),
	completedAt: v.optional(v.number()),
	error: v.optional(v.string()),
	retryAt: v.optional(v.number()),
	retryEligible: v.boolean()
});
export const storedApprovalRequest = v.object({
	context: changeKind,
	identity: v.string(),
	cutoff: v.number(),
	count: v.number(),
	id: v.string(),
	title: v.string(),
	recipientEmail: v.string(),
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	requestedAt: v.number(),
	deliveryId: v.id('emailDeliveries')
});
