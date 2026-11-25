import { v } from 'convex/values';

export const deletionIdentity = v.object({ issuer: v.string(), clerkId: v.string() });

const accountDeletion = v.object({
	issuer: v.string(),
	clerkId: v.string(),
	deletedAt: v.number(),
	cleanupJobId: v.optional(v.id('_scheduled_functions')),
	cleanupGeneration: v.number(),
	successorCursor: v.union(v.string(), v.null()),
	// An externally deleted sole owner requires an explicit operator handoff.
	recoveryCompanyId: v.optional(v.id('company'))
});
export const deletedUser = v.union(
	accountDeletion.extend({ complete: v.literal(false), profileId: v.id('profiles') }),
	accountDeletion.extend({ complete: v.literal(true), profileId: v.optional(v.id('profiles')) })
);

// Schema admission and worker order share one complete phase list.
export const companyCleanupPhases = [
	'invitations',
	'hubspot',
	'deliveries',
	'contractCleanups',
	'operationReceipts',
	'exports',
	'buyerActivity',
	'buyerLinks',
	'discussions',
	'contracts',
	'templateData',
	'csmBookings',
	'memberships',
	'company'
] as const;

const companyDeletionFields = v.object({
	companyId: v.id('company'),
	issuer: v.string(),
	clerkId: v.string(),
	executionId: v.string(),
	requestedAt: v.number(),
	cleanupJobId: v.optional(v.id('_scheduled_functions')),
	cleanupGeneration: v.number()
});
export const deletingCompanyRecord = v.object({
	id: v.id('companyDeletions'),
	executionId: v.string(),
	requestedAt: v.number(),
	issuer: v.string(),
	clerkId: v.string()
});
export const companyDeletion = v.union(
	companyDeletionFields.extend({
		status: v.literal('deleting'),
		inFlight: v.boolean(),
		phase: v.literal('invitations')
	}),
	companyDeletionFields.extend({
		status: v.literal('cleaning'),
		phase: v.union(...companyCleanupPhases.map((phase) => v.literal(phase)))
	}),
	companyDeletionFields.extend({ status: v.literal('complete'), phase: v.literal('company') })
);
