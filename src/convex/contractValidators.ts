import { v } from 'convex/values';
import { contractConcession, contractReview } from '../lib/contract/changes';
import { hubspotLink } from './hubspotValidators';

export const selections = v.record(v.id('playbookItems'), v.string());

export const contractBuyer = v.union(
	v.object({ kind: v.literal('manual') }),
	v.object({
		kind: v.literal('hubspot'),
		company: v.union(v.object({ id: v.string(), name: v.string() }), v.null())
	})
);

export const storedContract = v.object({
	companyId: v.id('company'),
	creatorId: v.id('profiles'),
	templateVersionId: v.id('templateVersions'),
	title: v.string(),
	buyer: contractBuyer,
	savedAt: v.number(),
	stateRevision: v.number(),
	metadataRevision: v.number(),
	lastOperation: v.optional(v.object({ id: v.string(), callerId: v.id('profiles') })),
	concessions: v.array(contractConcession),
	review: contractReview,
	quoteRequests: v.optional(
		v.object({
			watermark: v.number(),
			latest: v.optional(v.object({ requestedAt: v.number(), pushId: v.id('hubspotQuotePushes') }))
		})
	)
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

export const requestDeliveryStatus = v.object({
	generation: v.number(),
	requestedAt: v.number(),
	status: v.union(
		v.literal('sending'),
		v.literal('sent'),
		v.literal('failed'),
		v.literal('uncertain')
	),
	completedAt: v.optional(v.number()),
	error: v.optional(v.string()),
	retryAt: v.optional(v.number()),
	retryEligible: v.boolean()
});
