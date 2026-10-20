import { defineSchema, defineTable, docValidator } from 'convex/server';
import { v } from 'convex/values';
import { baselineBlock } from './sourceValidators';
import { playbookItem } from './playbookValidators';
import {
	storedApprovalRequest,
	selections,
	concessionReviews,
	reviewDecision,
	reviewStatus
} from './contractValidators';
import { role } from './permissions';
const playbookItems = defineTable(
	playbookItem.extend({
		companyId: v.id('company'),
		revision: v.optional(v.number()),
		lastOperationId: v.optional(v.string()),
		lastOperationCaller: v.optional(v.id('profiles'))
	})
).index('by_companyId', ['companyId']);
export default defineSchema({
	profiles: defineTable({
		identity: v.string(),
		issuer: v.string(),
		clerkId: v.string(),
		email: v.string(),
		name: v.string(),
		role,
		avatarId: v.optional(v.id('_storage'))
	})
		.index('by_identity', ['identity'])
		.index('by_email', ['email'])
		.index('by_issuer_and_clerkId', ['issuer', 'clerkId']),
	company: defineTable({
		ownerProfileId: v.optional(v.id('profiles')),
		approvalEmail: v.optional(v.string()),
		name: v.string(),
		avatarId: v.optional(v.id('_storage'))
	}).index('by_ownerProfileId', ['ownerProfileId']),
	memberships: defineTable({ profileId: v.id('profiles'), companyId: v.id('company') })
		.index('by_profileId', ['profileId'])
		.index('by_companyId', ['companyId']),
	companyInvitations: defineTable({
		companyId: v.id('company'),
		normalizedEmail: v.string(),
		inviterProfileId: v.id('profiles'),
		tokenHash: v.string(),
		expiresAt: v.number(),
		expired: v.optional(v.boolean()),
		status: v.union(v.literal('pending'), v.literal('accepted'), v.literal('revoked')),
		deliveryStatus: v.union(v.literal('sending'), v.literal('sent'), v.literal('failed')),
		deliveryGeneration: v.number(),
		deliveryStartedAt: v.optional(v.number()),
		acceptedByProfileId: v.optional(v.id('profiles')),
		acceptedAt: v.optional(v.number())
	})
		.index('by_normalizedEmail_and_status_and_expired_and_expiresAt', [
			'normalizedEmail',
			'status',
			'expired',
			'expiresAt'
		])
		.index('by_companyId_and_status', ['companyId', 'status'])
		.index('by_companyId_and_normalizedEmail_and_status', [
			'companyId',
			'normalizedEmail',
			'status'
		])
		.index('by_tokenHash', ['tokenHash']),
	deletedUsers: defineTable({
		issuer: v.string(),
		clerkId: v.string(),
		profileId: v.optional(v.id('profiles')),
		deletedAt: v.number(),
		complete: v.boolean(),
		cleanupJobId: v.optional(v.id('_scheduled_functions')),
		cleanupGeneration: v.optional(v.number()),
		successorCursor: v.optional(v.union(v.string(), v.null()))
	})
		.index('by_issuer_and_clerkId', ['issuer', 'clerkId'])
		.index('by_profileId', ['profileId'])
		.index('by_complete', ['complete']),
	companyDeletions: defineTable({
		companyId: v.id('company'),
		issuer: v.string(),
		clerkId: v.string(),
		attemptId: v.string(),
		requestedAt: v.number(),
		status: v.union(
			v.literal('prepared'),
			v.literal('dispatched'),
			v.literal('cleaning'),
			v.literal('complete')
		),
		phase: v.union(
			v.literal('invitations'),
			v.literal('approvals'),
			v.literal('decisions'),
			v.literal('contracts'),
			v.literal('blocks'),
			v.literal('items'),
			v.literal('snapshotBlocks'),
			v.literal('snapshotItems'),
			v.literal('itemReceipts'),
			v.literal('contractReceipts'),
			v.literal('versions'),
			v.literal('pointer'),
			v.literal('memberships'),
			v.literal('company')
		),
		cleanupJobId: v.optional(v.id('_scheduled_functions')),
		cleanupGeneration: v.optional(v.number())
	})
		.index('by_companyId', ['companyId'])
		.index('by_issuer_and_clerkId', ['issuer', 'clerkId'])
		.index('by_status', ['status']),
	contractBlocks: defineTable(
		v.union(...baselineBlock.members.map((member) => member.extend({ companyId: v.id('company') })))
	).index('by_companyId_and_order', ['companyId', 'order']),
	playbookItems,
	templateVersions: defineTable({
		companyId: v.id('company'),
		publishedAt: v.number(),
		blockCount: v.number(),
		itemCount: v.number(),
		snapshotBytes: v.number()
	}).index('by_companyId', ['companyId']),
	currentTemplate: defineTable({
		companyId: v.id('company'),
		versionId: v.optional(v.id('templateVersions')),
		maintenance: v.boolean(),
		importKey: v.optional(v.string()),
		baselineFingerprint: v.optional(v.string()),
		importBlockCount: v.optional(v.number()),
		importItemCount: v.optional(v.number())
	}).index('by_companyId', ['companyId']),
	templateVersionBlocks: defineTable({
		companyId: v.id('company'),
		versionId: v.id('templateVersions'),
		block: baselineBlock
	})
		.index('by_versionId', ['versionId'])
		.index('by_companyId', ['companyId']),
	templateVersionItems: defineTable({
		companyId: v.id('company'),
		versionId: v.id('templateVersions'),
		itemId: v.id('playbookItems'),
		// Keep the original identity even after the live playbook item is deleted.
		item: docValidator('playbookItems', playbookItems)
	})
		.index('by_versionId', ['versionId'])
		.index('by_companyId', ['companyId'])
		.index('by_versionId_and_itemId', ['versionId', 'itemId']),
	savedContracts: defineTable({
		companyId: v.id('company'),
		creatorId: v.optional(v.id('profiles')),
		templateVersionId: v.id('templateVersions'),
		companyName: v.string(),
		savedAt: v.number(),
		selectedConcessions: selections,
		reviews: v.optional(concessionReviews),
		revision: v.optional(v.number()),
		lastOperationId: v.optional(v.string()),
		lastOperationCaller: v.optional(v.id('profiles'))
	})
		.index('by_companyId_and_savedAt', ['companyId', 'savedAt'])
		.searchIndex('search_companyName', { searchField: 'companyName', filterFields: ['companyId'] }),
	concessionDecisions: defineTable({
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
	})
		.index('by_contractId', ['contractId'])
		.index('by_contractId_and_operationId', ['contractId', 'operationId'])
		.index('by_companyId', ['companyId']),
	approvalRequests: defineTable(storedApprovalRequest)
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	// Receipts survive contract deletion so a creation retry cannot resurrect it.
	contractCreationReceipts: defineTable({
		companyId: v.id('company'),
		operationId: v.string(),
		contractId: v.id('savedContracts')
	})
		.index('by_operationId', ['operationId'])
		.index('by_companyId', ['companyId']),
	// Transport receipts survive deletion; retry must never recreate a deleted item.
	creationReceipts: defineTable({
		companyId: v.id('company'),
		operationId: v.string(),
		itemId: v.id('playbookItems')
	})
		.index('by_operationId', ['operationId'])
		.index('by_companyId', ['companyId'])
});
