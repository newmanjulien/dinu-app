import { v } from 'convex/values';

export const selections = v.record(v.id('playbookItems'), v.string());
export const reviewStatus = v.union(
	v.literal('pending'),
	v.literal('approved'),
	v.literal('rejected')
);
export const reviewDecision = v.union(v.literal('approved'), v.literal('rejected'));
export const concessionReview = v.object({
	concessionId: v.string(),
	lifecycle: v.string(),
	status: reviewStatus
});
export const concessionReviews = v.record(v.id('playbookItems'), concessionReview);
export const selectionLifecycles = v.record(v.id('playbookItems'), v.string());
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
export const storedContract = v.object({
	companyId: v.id('company'),
	creatorId: v.id('profiles'),
	templateVersionId: v.id('templateVersions'),
	companyName: v.string(),
	savedAt: v.number(),
	selectedConcessions: selections,
	reviews: concessionReviews,
	revision: v.number(),
	reviewGeneration: v.number(),
	reviewCompletion: v.optional(reviewCompletion),
	stateVersion: v.number(),
	// A replay identity is absent or complete; its caller is always server-derived.
	lastOperation: v.optional(v.object({ id: v.string(), callerId: v.id('profiles') }))
});
export const storedDecision = v.object({
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	itemId: v.id('playbookItems'),
	concessionId: v.string(),
	lifecycle: v.string(),
	adminId: v.id('profiles'),
	adminName: v.string(),
	adminEmail: v.string(),
	operationId: v.string(),
	previousStatus: reviewStatus,
	status: reviewDecision,
	decidedAt: v.number(),
	changed: v.boolean()
});
// The item identity is resolved within this contract's immutable snapshot, even
// when the corresponding live playbook item has been deleted.
export const approvalSelection = v.object({
	itemId: v.id('playbookItems'),
	concessionPosition: v.number(),
	lifecycle: v.optional(v.string()),
	reviewStatus: v.optional(reviewStatus)
});
export const approvalRequest = v.object({
	id: v.string(),
	companyName: v.string(),
	selectedConcessions: v.array(approvalSelection),
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
	id: v.string(),
	companyName: v.string(),
	recipientEmail: v.string(),
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	requestedAt: v.number(),
	deliveryId: v.id('emailDeliveries')
});
