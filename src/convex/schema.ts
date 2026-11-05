import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { baselineBlock } from './sourceValidators';
import { historicalItem, playbookItem } from './playbookValidators';
import { storedApprovalRequest, storedContract, storedDecision } from './contractValidators';
import { role } from './permissions';
import { storedBaseline } from './baselineValidators';
import { emailDelivery, emailSelection } from './emailValidators';
import { storedInvitation } from './invitationValidators';
import { contractCleanupPhase } from './contractCleanupValidators';
import { deletedUser, companyDeletion } from './deletionValidators';
import {
	catalog as delegationCatalog,
	request as delegationRequest,
	attachment as delegationAttachment,
	cancellation as delegationCancellation
} from './delegationValidators';
const playbookItems = defineTable(
	historicalItem.omit('_id', '_creationTime').extend({
		publishedRevisionId: v.optional(v.id('playbookItemRevisions')),
		lastOperationId: v.optional(v.string()),
		lastOperationCaller: v.optional(v.id('profiles'))
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
		avatarId: v.optional(v.id('_storage'))
	})
		.index('by_identity', ['identity'])
		.index('by_email', ['email'])
		.index('by_issuer_and_clerkId', ['issuer', 'clerkId'])
		.index('by_avatarId', ['avatarId']),
	company: defineTable({
		ownerProfileId: v.optional(v.id('profiles')),
		approvalEmail: v.optional(v.string()),
		name: v.string(),
		avatarId: v.optional(v.id('_storage')),
		baselineId: v.optional(v.id('baselines'))
	})
		.index('by_ownerProfileId', ['ownerProfileId'])
		.index('by_avatarId', ['avatarId']),
	// A role belongs to the company membership.
	memberships: defineTable({
		profileId: v.id('profiles'),
		companyId: v.id('company'),
		role
	})
		.index('by_profileId', ['profileId'])
		.index('by_companyId', ['companyId']),
	companyInvitations: defineTable(storedInvitation)
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
	deletedUsers: defineTable(deletedUser)
		.index('by_issuer_and_clerkId', ['issuer', 'clerkId'])
		.index('by_profileId', ['profileId'])
		.index('by_complete', ['complete']),
	companyDeletions: defineTable(companyDeletion)
		.index('by_companyId', ['companyId'])
		.index('by_issuer_and_clerkId', ['issuer', 'clerkId'])
		.index('by_status_and_requestedAt', ['status', 'requestedAt']),
	baselines: defineTable(storedBaseline)
		.index('by_companyId', ['companyId'])
		.index('by_state_and_expiresAt', ['state', 'expiresAt'])
		.index('by_originalFileId', ['originalFileId']),
	fileSweeps: defineTable({
		kind: v.literal('storage-orphans'),
		completedThrough: v.union(v.number(), v.null()),
		active: v.union(
			v.object({ cutoff: v.number(), cursor: v.union(v.string(), v.null()) }),
			v.null()
		)
	}).index('by_kind', ['kind']),
	baselineChunks: defineTable({
		companyId: v.id('company'),
		baselineId: v.id('baselines'),
		order: v.number(),
		firstBlock: v.number(),
		blocks: v.array(baselineBlock)
	}).index('by_companyId_and_baselineId_and_order', ['companyId', 'baselineId', 'order']),
	playbookItems,
	playbookItemRevisions: defineTable({
		companyId: v.id('company'),
		itemId: v.id('playbookItems'),
		itemCreatedAt: v.number(),
		revision: v.number(),
		body: playbookItem,
		// A mutable template version owns these revisions until a contract freezes it.
		draftVersionId: v.optional(v.id('templateVersions'))
	}).index('by_companyId', ['companyId']),
	templateVersions: defineTable({
		companyId: v.id('company'),
		publishedAt: v.number(),
		blockCount: v.number(),
		itemCount: v.number(),
		snapshotBytes: v.number(),
		contentReadBytes: v.number(),
		baselineId: v.id('baselines'),
		// Versions stay mutable until a contract creation receipt references them.
		draft: v.boolean(),
		items: v.array(
			v.object({ itemId: v.id('playbookItems'), revisionId: v.id('playbookItemRevisions') })
		)
	}).index('by_companyId', ['companyId']),
	currentTemplate: defineTable({
		companyId: v.id('company'),
		versionId: v.id('templateVersions')
	}).index('by_companyId', ['companyId']),
	savedContracts: defineTable(storedContract).index('by_companyId', ['companyId']),
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
	contractCleanups: defineTable({
		companyId: v.id('company'),
		contractId: v.id('savedContracts'),
		phase: contractCleanupPhase,
		generation: v.number(),
		jobId: v.optional(v.id('_scheduled_functions'))
	})
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	concessionDecisions: defineTable(storedDecision)
		.index('by_contractId', ['contractId'])
		.index('by_contractId_and_operationId', ['contractId', 'operationId'])
		.index('by_companyId', ['companyId']),
	approvalRequests: defineTable(storedApprovalRequest)
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	emailDeliveries: defineTable(emailDelivery)
		.index('by_companyId', ['companyId'])
		.index('by_contractId', ['contractId'])
		.index('by_state_kind_and_event_kind_and_state_retryable_and_attempt', [
			'state.kind',
			'event.kind',
			'state.retryable',
			'attempt'
		])
		.index('by_state_kind_and_event_kind_and_state_retryEligible', [
			'state.kind',
			'event.kind',
			'state.retryEligible'
		])
		.index('by_disposal_generation', ['disposal.generation']),
	emailSnapshots: defineTable({
		companyId: v.id('company'),
		deliveryId: v.id('emailDeliveries'),
		order: v.number(),
		selections: v.array(emailSelection)
	})
		.index('by_deliveryId_and_order', ['deliveryId', 'order'])
		.index('by_companyId', ['companyId']),
	// Receipts survive contract deletion so a creation retry cannot resurrect it.
	contractCreationReceipts: defineTable({
		companyId: v.id('company'),
		operationId: v.string(),
		contractId: v.id('savedContracts'),
		// Kept optional for receipt rows written before version freezing moved onto
		// the template itself. New receipts no longer need a reverse lookup.
		templateVersionId: v.optional(v.id('templateVersions'))
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
