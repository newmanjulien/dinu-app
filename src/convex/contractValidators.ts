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
const legacyApprovalRequest = approvalRequest.extend({
	recipientEmail: v.string(),
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	sendJobId: v.id('_scheduled_functions'),
	dispatchStarted: v.boolean(),
	messageId: v.optional(v.string())
});
// Existing deployments can be upgraded before running emailMigration.upgrade.
export const storedApprovalRequest = v.union(
	legacyApprovalRequest,
	v.object({
		id: v.string(),
		companyName: v.string(),
		recipientEmail: v.string(),
		companyId: v.id('company'),
		contractId: v.id('savedContracts'),
		requestedAt: v.number(),
		deliveryId: v.id('emailDeliveries')
	})
);

// Retained only to read and migrate records from existing deployments.
const notificationDecision = v.object({
	itemId: v.id('playbookItems'),
	concessionId: v.string(),
	lifecycle: v.string(),
	status: reviewDecision,
	reviewerId: v.optional(v.id('profiles')),
	reviewerName: v.optional(v.string())
});
const notificationOutcome = v.union(
	v.literal('sent'),
	v.literal('partial'),
	v.literal('failed'),
	v.literal('uncertain'),
	v.literal('skipped')
);
export const storedDecisionNotification = v.object({
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	companyName: v.string(),
	templateVersionId: v.id('templateVersions'),
	fingerprint: v.string(),
	decisions: v.array(notificationDecision),
	status: v.union(v.literal('sending'), notificationOutcome),
	createdAt: v.number(),
	completedAt: v.optional(v.number()),
	sendJobId: v.optional(v.id('_scheduled_functions')),
	recoveryJobId: v.optional(v.id('_scheduled_functions')),
	dispatchStarted: v.boolean(),
	recipientEmail: v.optional(v.string()),
	cc: v.optional(v.array(v.string())),
	recipientAccepted: v.optional(v.boolean()),
	accepted: v.optional(v.array(v.string())),
	rejected: v.optional(v.array(v.string())),
	error: v.optional(v.string()),
	messageId: v.optional(v.string())
});
