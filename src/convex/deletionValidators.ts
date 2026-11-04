import { v } from 'convex/values';

export const PREPARATION_TTL = 15 * 60_000;
export const DELETION_ATTEMPT_MAX_LENGTH = 128;
export const MEMBERSHIP_ELIGIBILITY_SCAN_LIMIT = 100;

// Discovery targets and provider/write limits have separate owners.
export const RECONCILIATION_PAGE_SIZE = 100;
export const CLERK_USER_BATCH_SIZE = 100;
export const ACCOUNT_DELETION_BATCH_SIZE = 25;
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
	'approvals',
	'deliveries',
	'emailSnapshots',
	'decisions',
	'contracts',
	'contractDirectory',
	'contractCleanups',
	'blocks',
	'items',
	'itemReceipts',
	'contractReceipts',
	'versions',
	'pointer',
	'baselines',
	'itemRevisions',
	'delegationAttachments',
	'delegationRequests',
	'delegationCancellations',
	'memberships',
	'company'
] as const;
const companyDeletionFields = v.object({
	companyId: v.id('company'),
	issuer: v.string(),
	clerkId: v.string(),
	attemptId: v.string(),
	requestedAt: v.number(),
	cleanupJobId: v.optional(v.id('_scheduled_functions')),
	cleanupGeneration: v.number()
});
export const companyDeletion = v.union(
	companyDeletionFields.extend({
		status: v.union(v.literal('prepared'), v.literal('dispatched')),
		phase: v.literal('invitations')
	}),
	companyDeletionFields.extend({
		status: v.literal('cleaning'),
		phase: v.union(...companyCleanupPhases.map((phase) => v.literal(phase)))
	}),
	companyDeletionFields.extend({ status: v.literal('complete'), phase: v.literal('company') })
);
