import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { baselineBlock } from './sourceValidators';
import { historicalItem } from './playbookValidators';
import {
	storedApprovalRequest,
	storedDecisionNotification,
	selections,
	concessionReviews,
	reviewDecision,
	reviewStatus
} from './contractValidators';
import { role } from './permissions';
import { issue as uploadIssue } from './baselineUploadValidators';
import { emailDelivery, emailSelection } from './emailValidators';
import {
	catalog as delegationCatalog,
	request as delegationRequest,
	attachment as delegationAttachment,
	cancellation as delegationCancellation
} from './delegationValidators';
const playbookItems = defineTable(
	historicalItem.omit('_id', '_creationTime').extend({
		publishedRevisionId: v.optional(v.id('playbookItemRevisions'))
	})
).index('by_companyId', ['companyId']);
export default defineSchema({
	delegationCatalog: defineTable(delegationCatalog).index('by_key', ['key']),
	delegationRequests: defineTable(delegationRequest)
		.index('by_operationId', ['operationId'])
		.index('by_companyId', ['companyId']),
	delegationAttachments: defineTable(delegationAttachment)
		.index('by_storageId', ['storageId'])
		.index('by_companyId', ['companyId'])
		.index('by_companyId_and_uploaderId_and_draftId_and_uploadId', [
			'companyId',
			'uploaderId',
			'draftId',
			'uploadId'
		])
		.index('by_state_and_expiresAt', ['state', 'expiresAt']),
	delegationCancellations: defineTable(delegationCancellation)
		.index('by_companyId_and_uploaderId_and_draftId_and_uploadId', [
			'companyId',
			'uploaderId',
			'draftId',
			'uploadId'
		])
		.index('by_expiresAt', ['expiresAt'])
		.index('by_companyId', ['companyId']),
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
		avatarId: v.optional(v.id('_storage')),
		contractDirectoryReady: v.optional(v.boolean())
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
		deliveryId: v.optional(v.id('emailDeliveries')),
		expiryJobId: v.optional(v.id('_scheduled_functions')),
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
			v.literal('notifications'),
			v.literal('deliveries'),
			v.literal('emailSnapshots'),
			v.literal('reviewAttributions'),
			v.literal('decisions'),
			v.literal('contracts'),
			v.literal('contractDirectory'),
			v.literal('blocks'),
			v.literal('items'),
			v.literal('snapshotItems'),
			v.literal('itemReceipts'),
			v.literal('contractReceipts'),
			v.literal('versions'),
			v.literal('pointer'),
			v.literal('baselines'),
			v.literal('itemRevisions'),
			v.literal('delegationAttachments'),
			v.literal('delegationRequests'),
			v.literal('delegationCancellations'),
			v.literal('memberships'),
			v.literal('company')
		),
		cleanupJobId: v.optional(v.id('_scheduled_functions')),
		cleanupGeneration: v.optional(v.number())
	})
		.index('by_companyId', ['companyId'])
		.index('by_issuer_and_clerkId', ['issuer', 'clerkId'])
		.index('by_status', ['status']),
	baselines: defineTable({
		companyId: v.id('company'),
		state: v.union(v.literal('prepared'), v.literal('published'), v.literal('deleting')),
		source: v.union(v.literal('docx'), v.literal('seed')),
		originalFileId: v.optional(v.id('_storage')),
		filename: v.optional(v.string()),
		fileHash: v.optional(v.string()),
		fingerprint: v.string(),
		parserVersion: v.optional(v.string()),
		uploaderId: v.optional(v.id('profiles')),
		issues: v.array(uploadIssue),
		blockCount: v.number(),
		expiresAt: v.optional(v.number()),
		publishedAt: v.optional(v.number())
	})
		.index('by_companyId', ['companyId'])
		.index('by_state_and_expiresAt', ['state', 'expiresAt'])
		.index('by_originalFileId', ['originalFileId']),
	fileSweeps: defineTable({
		kind: v.literal('docx-orphans'),
		completedThrough: v.union(v.number(), v.null()),
		active: v.union(
			v.object({ cutoff: v.number(), cursor: v.union(v.string(), v.null()) }),
			v.null()
		)
	}).index('by_kind', ['kind']),
	contractBlocks: defineTable(
		v.union(
			...baselineBlock.members.map((member) =>
				member.extend({ companyId: v.id('company'), baselineId: v.id('baselines') })
			)
		)
	)
		.index('by_baselineId_and_order', ['baselineId', 'order'])
		.index('by_companyId_and_baselineId_and_order', ['companyId', 'baselineId', 'order']),
	playbookItems,
	playbookItemRevisions: defineTable({
		companyId: v.id('company'),
		itemId: v.id('playbookItems'),
		item: historicalItem
	}).index('by_companyId', ['companyId']),
	templateVersions: defineTable({
		companyId: v.id('company'),
		publishedAt: v.number(),
		blockCount: v.number(),
		itemCount: v.number(),
		snapshotBytes: v.number(),
		baselineId: v.id('baselines')
	}).index('by_companyId', ['companyId']),
	currentTemplate: defineTable({
		companyId: v.id('company'),
		baselineId: v.id('baselines'),
		versionId: v.optional(v.id('templateVersions')),
		maintenance: v.boolean(),
		importKey: v.optional(v.string()),
		baselineFingerprint: v.optional(v.string()),
		importBlockCount: v.optional(v.number()),
		importItemCount: v.optional(v.number())
	}).index('by_companyId', ['companyId']),
	templateVersionItems: defineTable({
		companyId: v.id('company'),
		versionId: v.id('templateVersions'),
		itemId: v.id('playbookItems'),
		revisionId: v.id('playbookItemRevisions')
	})
		.index('by_versionId', ['versionId'])
		.index('by_companyId', ['companyId'])
		.index('by_versionId_and_itemId', ['versionId', 'itemId']),
	savedContracts: defineTable({
		companyId: v.id('company'),
		creatorId: v.id('profiles'),
		templateVersionId: v.id('templateVersions'),
		companyName: v.string(),
		savedAt: v.number(),
		selectedConcessions: selections,
		reviews: concessionReviews,
		revision: v.number(),
		reviewGeneration: v.optional(v.number()),
		lastOperationId: v.optional(v.string()),
		lastOperationCaller: v.optional(v.id('profiles'))
	})
		.index('by_companyId_and_savedAt', ['companyId', 'savedAt'])
		.searchIndex('search_companyName', { searchField: 'companyName', filterFields: ['companyId'] }),
	// Browsing never reads the growing selections or review state of a contract.
	contractDirectory: defineTable({
		contractId: v.id('savedContracts'),
		companyId: v.id('company'),
		creatorId: v.id('profiles'),
		companyName: v.string(),
		savedAt: v.number(),
		createdAt: v.number()
	})
		.index('by_contractId', ['contractId'])
		.index('by_companyId_and_savedAt_and_createdAt', ['companyId', 'savedAt', 'createdAt'])
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
		changed: v.boolean(),
		reviewCompleted: v.optional(v.boolean())
	})
		.index('by_contractId', ['contractId'])
		.index('by_contractId_and_operationId', ['contractId', 'operationId'])
		.index('by_contractId_and_itemId_and_lifecycle_and_changed', [
			'contractId',
			'itemId',
			'lifecycle',
			'changed'
		])
		.index('by_companyId', ['companyId']),
	// Read-only legacy table; emailMigration.upgrade archives and drains it.
	decisionNotifications: defineTable(storedDecisionNotification)
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	approvalRequests: defineTable(storedApprovalRequest)
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	emailDeliveries: defineTable(emailDelivery)
		.index('by_companyId', ['companyId'])
		.index('by_contractId', ['contractId']),
	emailSnapshots: defineTable({
		companyId: v.id('company'),
		deliveryId: v.id('emailDeliveries'),
		order: v.number(),
		selections: v.array(emailSelection)
	})
		.index('by_deliveryId_and_order', ['deliveryId', 'order'])
		.index('by_companyId', ['companyId']),
	reviewAttributions: defineTable({
		companyId: v.id('company'),
		contractId: v.id('savedContracts'),
		entries: v.array(
			v.object({
				itemId: v.id('playbookItems'),
				applicationKey: v.string(),
				reviewerId: v.id('profiles'),
				reviewerName: v.string()
			})
		)
	})
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
