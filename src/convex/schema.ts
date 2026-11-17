import { templateItem } from '../lib/playbook/validators';
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { sourceBlock } from '../lib/document/source-validators';
import { storedTemplateSource } from './templateSourceValidators';
import { contractOutput, outputProofCursor } from './outputValidators';
import { contractCleanupPhase } from './contractCleanupValidators';
import {
	storedApprovalRequest,
	storedContract,
	storedContractHubspotAssociation,
	contractBuyerRefresh
} from './contractValidators';
import { companyDeletion, deletedUser } from './deletionValidators';
import { emailDelivery, nativeEmailEntry } from './emailValidators';
import { storedInvitation } from './invitationValidators';
import {
	hubspotLink,
	hubspotConnection,
	hubspotOAuthState,
	hubspotEvent,
	hubspotRemoval,
	hubspotAccountRemoval
} from './hubspotValidators';
import { role } from './permissions';
import { helpPreferences } from './accountViews';
import { operationReceipt } from './operationReceiptValidators';
import { nativeStage } from './nativeStageValidators';
import { storedExportAttempt } from './exportValidators';
import { hubspotExportDelivery } from './hubspotExportDeliveryValidators';
import { quoteInstallation, quotePush } from './hubspotQuoteValidators';
import { buyerLink } from './buyerValidators';
import { storedThread, storedMessage, storedReceipt } from './discussionValidators';
import {
	storedInvalidation,
	storedMapChunk,
	storedUnreadNode,
	storedUnreadControl,
	storedPassageClaim
} from './discussionIndexValidators';
import {
	storedContractChange,
	storedContractChangeHead,
	storedContractChangeDecision,
	storedChangeContent
} from './contractChangeValidators';
import {
	activityQuotaKey,
	discussionQuotaKey,
	activityOpening,
	activityReceipt
} from './buyerActivityValidators';
import { storedCsmAttempt } from './csmBookingValidators';
import { storedMeetingPreparation } from './csmMeetingValidators';
import { storedSetupAppointment } from './csmSetupValidators';
import { storedEvidence } from './csmEvidenceValidators';
import { storedErasureGuard } from './csmErasureGuardValidators';
import { storedTemplateItem } from './playbookValidators';
import { retentionSweep } from './retentionValidators';
/** Domain map: docs/data-model.md. Child company IDs support authorization and bounded cleanup. */
export default defineSchema({
	// HubSpot integration lifecycle and provider work.
	hubspotLinkBlocks: defineTable({
		companyId: v.id('company'),
		contractId: v.id('savedContracts'),
		generation: v.number()
	})
		.index('by_companyId', ['companyId'])
		.index('by_contractId', ['contractId'])
		.index('by_contractId_and_generation', ['contractId', 'generation']),
	hubspotQuoteInstallations: defineTable(quoteInstallation).index('by_companyId', ['companyId']),
	hubspotQuotePushes: defineTable(quotePush)
		.index('by_outputId', ['outputId'])
		.index('by_companyId', ['companyId'])
		.index('by_contractId', ['contractId'])
		.index('by_canonicalKey', ['canonicalKey'])
		.index('by_canonicalKey_and_state', ['canonicalKey', 'state'])
		.index('by_destination_connectionId', ['destination.connectionId'])
		.index('by_state_and_dueAt', ['state', 'dueAt'])
		.index('by_fileId', ['fileId'])
		.index('by_payloadExpiresAt', ['payloadExpiresAt'])
		.index('by_providerFailure_expiresAt', ['providerFailure.expiresAt']),
	hubspotConnections: defineTable(hubspotConnection)
		.index('by_companyId', ['companyId'])
		.index('by_accountId', ['accountId'])
		.index('by_accountId_and_status', ['accountId', 'status']),
	hubspotJournal: defineTable({
		name: v.literal('lifecycle'),
		offset: v.optional(v.string()),
		processingOffset: v.optional(v.string()),
		position: v.number(),
		checkedAt: v.number(),
		claim: v.optional(v.string()),
		leaseUntil: v.optional(v.number()),
		diagnostic: v.optional(v.string())
	}).index('by_name', ['name']),
	hubspotPortalLifecycle: defineTable({
		accountId: v.string(),
		installedAt: v.optional(v.number()),
		uninstalledAt: v.optional(v.number()),
		diagnostic: v.optional(v.string())
	}).index('by_accountId', ['accountId']),
	// Version survives uninstall and rejects callbacks reserved before the removal.
	hubspotLifecycles: defineTable({
		companyId: v.id('company'),
		version: v.number(),
		removedAt: v.optional(v.number()),
		removalId: v.optional(v.id('hubspotRemovals'))
	}).index('by_companyId', ['companyId']),
	hubspotRemovals: defineTable(hubspotRemoval)
		.index('by_companyId', ['companyId'])
		.index('by_connectionId', ['connectionId'])
		.index('by_done_and_dueAt', ['done', 'dueAt']),
	hubspotAccountRemovals: defineTable(hubspotAccountRemoval)
		.index('by_accountId_and_blocking', ['accountId', 'blocking'])
		.index('by_dueAt', ['dueAt']),
	hubspotOAuthStates: defineTable(hubspotOAuthState)
		.index('by_hash', ['hash'])
		.index('by_expiresAt', ['expiresAt'])
		.index('by_companyId', ['companyId']),
	hubspotEvents: defineTable(hubspotEvent)
		.index('by_attemptId', ['attemptId'])
		.index('by_companyId', ['companyId'])
		.index('by_destination_connectionId', ['destination.connectionId'])
		.index('by_key', ['key'])
		.index('by_status_and_dueAt', ['status', 'dueAt']),
	// Core operation replay; survives individual contract deletion.
	operationReceipts: defineTable(operationReceipt)
		.index('by_gcAfter', ['gcAfter'])
		.index('by_actor_profileId_and_state', ['actor.profileId', 'state'])
		.index('by_actor_profileId_and_emailPreparation_dueAt', [
			'actor.profileId',
			'emailPreparation.dueAt'
		])
		.index('by_documentId', ['documentId'])
		.index('by_nativeCleanup_dueAt', ['nativeCleanup.dueAt'])
		.index('by_contractId_and_state_and_preparation_map_mapKey', [
			'contractId',
			'state',
			'preparation.map.mapKey'
		])
		.index('by_contractId_and_state_and_preparation_dueAt', [
			'contractId',
			'state',
			'preparation.dueAt'
		])
		.index('by_contractId_and_state_and_emailPreparation_dueAt', [
			'contractId',
			'state',
			'emailPreparation.dueAt'
		])
		.index('by_companyId', ['companyId'])
		.index('by_key', ['key'])
		.index('by_contractId', ['contractId']),
	retentionSweeps: defineTable(retentionSweep).index('by_name', ['name']),
	contractOutputs: defineTable(contractOutput)
		.index('by_retentionDueAt', ['retentionDueAt'])
		.index('by_receiptId', ['receiptId'])
		.index('by_actor_profileId_and_outputPreparation_purpose', [
			'actor.profileId',
			'outputPreparation.purpose'
		])
		.index('by_companyId', ['companyId'])
		.index('by_contractId', ['contractId'])
		.index('by_contractId_and_format', ['contractId', 'format'])
		.index('by_documentId', ['documentId'])
		.index('by_providerOperationId', ['providerOperationId'])
		.index('by_outputPreparation_dueAt', ['outputPreparation.dueAt'])
		.index('by_outputCleanup_dueAt', ['outputCleanup.dueAt']),
	contractOutputChunks: defineTable({
		companyId: v.id('company'),
		contractId: v.id('savedContracts'),
		outputId: v.id('contractOutputs'),
		section: v.literal('output-proof'),
		generation: v.number(),
		order: v.number(),
		fingerprint: v.string(),
		recordCount: v.number(),
		data: v.string()
	})
		.index('by_companyId', ['companyId'])
		.index('by_contractId', ['contractId'])
		.index('by_outputId_and_section_and_generation_and_order', [
			'outputId',
			'section',
			'generation',
			'order'
		]),
	operationReceiptChunks: defineTable({
		companyId: v.id('company'),
		receiptId: v.id('operationReceipts'),
		section: v.union(
			v.literal('payload'),
			v.literal('native-plan'),
			v.literal('native-sources'),
			v.literal('native-result')
		),
		generation: v.number(),
		nativeKey: v.optional(v.string()),
		order: v.number(),
		fingerprint: v.string(),
		recordCount: v.number(),
		data: v.string()
	})
		.index('by_companyId', ['companyId'])
		.index('by_receiptId_and_section_and_generation_and_order', [
			'receiptId',
			'section',
			'generation',
			'order'
		])
		.index('by_receiptId_and_section_and_generation_and_nativeKey', [
			'receiptId',
			'section',
			'generation',
			'nativeKey'
		]),
	hubspotExportDeliveries: defineTable(hubspotExportDelivery)
		.index('by_companyId', ['companyId'])
		.index('by_attemptId', ['attemptId'])
		.index('by_destination_connectionId', ['destination.connectionId']),
	// Core export attempts/provenance. Physical names and IDs preserve indefinite browser journals.
	hubspotExports: defineTable(storedExportAttempt)
		.index('by_outputId', ['outputId'])
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId'])
		.index('by_key', ['key'])
		.index('by_fileId', ['fileId'])
		.index('by_state_and_expiresAt', ['state', 'expiresAt']),

	// Accounts and companies
	profiles: defineTable({
		helpPreferences,
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
	// A missing owner permits operator recovery; a missing templateSource means setup is incomplete.
	company: defineTable({
		ownerProfileId: v.optional(v.id('profiles')),
		approvalEmail: v.optional(v.string()),
		name: v.string(),
		avatarId: v.optional(v.id('_storage')),
		templateSourceId: v.optional(v.id('templateSources')),
		pendingTemplateSourceId: v.optional(v.id('templateSources')),
		colleaguesInvitedAt: v.optional(v.number()),
		setupAppointmentId: v.optional(v.id('csmSetupAppointments')),
		authoringMigration: v.optional(v.boolean())
	})
		.index('by_ownerProfileId', ['ownerProfileId'])
		.index('by_avatarId', ['avatarId']),
	// One membership per profile, enforced by the indexed transactional join. Role belongs here.
	memberships: defineTable({
		profileId: v.id('profiles'),
		companyId: v.id('company'),
		// Retired copy milestone; setup now checks buyerLinks directly.
		setupCompletedAt: v.optional(v.number()),
		firstBuyerLinkHintShowing: v.optional(v.object({ visitId: v.string(), shownAt: v.number() })),
		role
	})
		.index('by_profileId', ['profileId'])
		.index('by_companyId', ['companyId']),
	csmErasedInitialGuards: defineTable(storedErasureGuard)
		.index('by_companyId_and_blocking', ['companyId', 'blocking'])
		.index('by_dispatchId', ['dispatchId'])
		.index('by_observeAt', ['observeAt']),
	csmWebhookEvidence: defineTable(storedEvidence)
		.index('by_identity', ['identity'])
		.index('by_dueAt', ['dueAt'])
		.index('by_completedAt', ['completedAt'])
		.index('by_attemptId', ['attemptId'])
		.index('by_attemptId_and_state', ['attemptId', 'state'])
		.index('by_appointmentId', ['appointmentId'])
		.index('by_appointmentId_and_state', ['appointmentId', 'state'])
		.index('by_appointmentId_and_state_and_evidenceGeneration', [
			'appointmentId',
			'state',
			'evidenceGeneration'
		])
		.index('by_companyId', ['companyId'])
		.index('by_profileId', ['profileId']),
	csmSetupAppointments: defineTable(storedSetupAppointment)
		.index('by_attemptId', ['attemptId'])
		.index('by_anchorUid', ['anchorUid'])
		.index('by_currentUid', ['currentUid'])
		.index('by_companyId_and_selection_and_sortAt_and_anchorUid', [
			'companyId',
			'selection',
			'sortAt',
			'anchorUid'
		])
		.index('by_profileId', ['profileId'])
		.index('by_repairAt', ['repairAt']),
	csmMeetingPreparations: defineTable(storedMeetingPreparation)
		.index('by_dueAt', ['dueAt'])
		.index('by_uid', ['uid'])
		.index('by_companyId', ['companyId'])
		.index('by_profileId', ['profileId'])
		.index('by_state', ['state']),
	csmBookingAttempts: defineTable(storedCsmAttempt)
		.index('by_companyId_and_mode_and_state', ['companyId', 'mode', 'state'])
		.index('by_membershipId_and_operationId', ['membershipId', 'operationId'])
		.index('by_membershipId_and_state', ['membershipId', 'state'])
		.index('by_membershipId_and_state_and_confirmation', ['membershipId', 'state', 'confirmation'])
		.index('by_membershipId_and_state_and_format', ['membershipId', 'state', 'format'])
		.index('by_companyId', ['companyId'])
		.index('by_profileId', ['profileId'])
		.index('by_recoveryDue', ['recoveryDue']),
	companyInvitations: defineTable(storedInvitation)
		.index('by_normalizedEmail_and_status_and_expired_and_expiresAt', [
			'normalizedEmail',
			'status',
			'expired',
			'expiresAt'
		])
		.index('by_companyId_and_status', ['companyId', 'status'])
		.index('by_companyId_and_deliveryStatus', ['companyId', 'deliveryStatus'])
		.index('by_companyId_and_normalizedEmail_and_status', [
			'companyId',
			'normalizedEmail',
			'status'
		])
		.index('by_tokenHash', ['tokenHash']),

	// Template authoring and captured history
	templateSources: defineTable(storedTemplateSource)
		.index('by_companyId', ['companyId'])
		.index('by_companyId_and_state', ['companyId', 'state'])
		.index('by_state_and_expiresAt', ['state', 'expiresAt'])
		.index('by_originalFileId', ['originalFileId']),
	templateSourceChunks: defineTable({
		companyId: v.id('company'),
		templateSourceId: v.id('templateSources'),
		order: v.number(),
		firstBlock: v.number(),
		blocks: v.array(sourceBlock)
	}).index('by_companyId_and_templateSourceId_and_order', [
		'companyId',
		'templateSourceId',
		'order'
	]),
	templateSourceCertificates: defineTable({
		companyId: v.id('company'),
		templateSourceId: v.id('templateSources'),
		format: v.number(),
		fingerprint: v.string(),
		chunkCount: v.number(),
		chunkIds: v.array(v.id('templateSourceValidationChunks')),
		dataBytes: v.number(),
		readBytes: v.number()
	}).index('by_companyId_and_templateSourceId', ['companyId', 'templateSourceId']),
	templateSourceValidationChunks: defineTable({
		companyId: v.id('company'),
		templateSourceId: v.id('templateSources'),
		order: v.number(),
		data: v.bytes()
	}).index('by_companyId_and_templateSourceId_and_order', [
		'companyId',
		'templateSourceId',
		'order'
	]),
	authoringMigrations: defineTable({
		companyId: v.id('company'),
		templateSourceId: v.id('templateSources'),
		fingerprint: v.string(),
		versionId: v.id('templateVersions'),
		generation: v.number(),
		state: v.union(
			v.literal('heads'),
			v.literal('versions'),
			v.literal('certify'),
			v.literal('complete')
		),
		nextItem: v.number(),
		versionCursor: v.optional(v.string())
	}).index('by_companyId', ['companyId']),
	playbookItems: defineTable(storedTemplateItem).index('by_companyId', ['companyId']),
	// Historical item IDs remain valid after the live item is deleted.
	playbookItemRevisions: defineTable({
		companyId: v.id('company'),
		itemId: v.id('playbookItems'),
		itemCreatedAt: v.number(),
		contentRevision: v.number(),
		body: templateItem,
		lastOperation: v.optional(v.object({ id: v.string(), callerId: v.id('profiles') })),
		renderKey: v.optional(v.string()),
		// A mutable template version owns these revisions until a contract freezes it.
		mutableVersionId: v.optional(v.id('templateVersions'))
	}).index('by_companyId', ['companyId']),
	templateVersions: defineTable({
		companyId: v.id('company'),
		templateSourceId: v.id('templateSources'),
		items: v.array(
			v.object({ itemId: v.id('playbookItems'), revisionId: v.id('playbookItemRevisions') })
		),
		// First contract capture freezes this version permanently, even if the contract is deleted.
		mutability: v.union(v.literal('mutable'), v.literal('frozen')),
		updatedAt: v.number(),
		// Derived admission accounting, maintained atomically when saving the version.
		blockCount: v.number(),
		itemCount: v.number(),
		snapshotBytes: v.number(),
		contentReadBytes: v.number(),
		headReadBytes: v.optional(v.number()),
		structureResultBytes: v.optional(v.number()),
		authoringGeneration: v.optional(v.number()),
		structuralGeneration: v.optional(v.number()),
		validation: v.optional(v.object({ format: v.number(), fingerprint: v.string() }))
	}).index('by_companyId', ['companyId']),

	// One pointer per company, enforced by the template version writer.
	currentTemplate: defineTable({
		companyId: v.id('company'),
		versionId: v.id('templateVersions'),
		// Historical fallback/output mirrors only. Present manifest clocks are authoritative.
		authoringGeneration: v.optional(v.number()),
		structuralGeneration: v.optional(v.number())
	}).index('by_companyId', ['companyId']),
	// Survives item deletion: retry must never recreate a deleted item.
	playbookItemCreationReceipts: defineTable({
		companyId: v.id('company'),
		renderKey: v.optional(v.string()),
		operationId: v.string(),
		itemId: v.id('playbookItems')
	})
		.index('by_operationId', ['operationId'])
		.index('by_companyId_and_renderKey', ['companyId', 'renderKey'])
		.index('by_companyId', ['companyId']),

	// A permanent buyer link with its small atomically updated approved-view pointer.
	buyerLinks: defineTable(buyerLink)
		.index('by_token', ['token'])
		.index('by_contractId', ['contractId'])
		.index('by_companyId_and_creatorId', ['companyId', 'creatorId'])
		.index('by_companyId', ['companyId']),
	buyerLinkBarShowings: defineTable({
		membershipId: v.id('memberships'),
		companyId: v.id('company'),
		contractId: v.id('savedContracts'),
		visitId: v.string(),
		shownAt: v.number()
	})
		.index('by_membershipId_and_contractId', ['membershipId', 'contractId'])
		.index('by_membershipId', ['membershipId'])
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	buyerLinkShowingCleanups: defineTable({
		membershipId: v.id('memberships'),
		companyId: v.id('company'),
		generation: v.number(),
		jobId: v.optional(v.id('_scheduled_functions'))
	})
		.index('by_membershipId', ['membershipId'])
		.index('by_companyId', ['companyId']),
	buyerActivityOpenings: defineTable(activityOpening)
		.index('by_contractId_and_openingId', ['contractId', 'openingId'])
		.index('by_contractId_and_visitId_and_expiresAt', ['contractId', 'visitId', 'expiresAt'])
		.index('by_contractId_and_expiresAt', ['contractId', 'expiresAt'])
		.index('by_contractId_and_browserId_and_profileId_and_acceptedAt', [
			'contractId',
			'browserId',
			'profileId',
			'acceptedAt'
		])
		.index('by_contractId_and_profileId_and_acceptedAt', ['contractId', 'profileId', 'acceptedAt'])
		.index('by_profileId', ['profileId'])
		.index('by_expiresAt', ['expiresAt'])
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	buyerActivityReceipts: defineTable(activityReceipt)
		.index('by_contractId_and_eventId', ['contractId', 'eventId'])
		.index('by_openingId_and_itemId', ['openingId', 'itemId'])
		.index('by_expiresAt', ['expiresAt'])
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	buyerActivityCounters: defineTable({
		companyId: v.id('company'),
		contractId: v.id('savedContracts'),
		nextVisitorNumber: v.number()
	})
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	discussionQuotaKeys: defineTable(discussionQuotaKey)
		.index('by_name_and_key', ['name', 'key'])
		.index('by_expiresAt', ['expiresAt'])
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	buyerActivityQuotaKeys: defineTable(activityQuotaKey)
		.index('by_name_and_key', ['name', 'key'])
		.index('by_expiresAt', ['expiresAt'])
		.index('by_companyId', ['companyId'])
		.index('by_contractId', ['contractId']),
	discussionInvalidations: defineTable(storedInvalidation)
		.index('by_contractId_and_map_mapKey', ['contractId', 'map.mapKey'])
		.index('by_contractId_and_fromRevision', ['contractId', 'fromRevision'])
		.index('by_companyId', ['companyId'])
		.index('by_contractId', ['contractId']),
	discussionTransitionMapChunks: defineTable(storedMapChunk)
		.index('by_mapKey_and_firstBefore', ['mapKey', 'firstBefore'])
		.index('by_contractId_and_garbage', ['contractId', 'garbage'])
		.index('by_companyId', ['companyId'])
		.index('by_contractId', ['contractId']),
	discussionUnreadNodes: defineTable(storedUnreadNode)
		.index('by_companyId', ['companyId'])
		.index('by_contractId', ['contractId']),
	discussionUnreadControls: defineTable(storedUnreadControl)
		.index('by_contractId', ['contractId'])
		.index('by_dueAt', ['dueAt'])
		.index('by_companyId', ['companyId']),
	discussionPassageClaims: defineTable(storedPassageClaim)
		.index('by_contractId_and_indexedDocumentRevision_and_start', [
			'contractId',
			'indexedDocumentRevision',
			'start'
		])
		.index('by_threadId', ['threadId'])
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	discussionThreads: defineTable(storedThread)
		.index('by_contractId_and_tombstoned_and_cleanupDueAt', [
			'contractId',
			'tombstoned',
			'cleanupDueAt'
		])
		.index('by_contractId_and_tombstoned_and_indexedDocumentRevision', [
			'contractId',
			'tombstoned',
			'indexedDocumentRevision'
		])
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	discussionMessages: defineTable(storedMessage)
		.index('by_threadId_and_reply', ['threadId', 'reply'])
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	discussionReceipts: defineTable(storedReceipt)
		.index('by_gcAfter', ['gcAfter'])
		.index('by_threadId', ['threadId'])
		.index('by_contractId_and_actorKey_and_operationId', ['contractId', 'actorKey', 'operationId'])
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	// Contracts and approvals
	savedContracts: defineTable(storedContract).index('by_companyId', ['companyId']),
	// Immutable materialized wording; each manifest shares unchanged content-addressed chunks.
	contractDocuments: defineTable({
		stage: v.optional(nativeStage),
		companyId: v.id('company'),
		contractId: v.id('savedContracts'),
		format: v.literal(1),
		fingerprint: v.string(),
		chunkIds: v.array(v.id('contractDocumentChunks')),
		chunkHashes: v.array(v.string()),
		dataBytes: v.number(),
		readBytes: v.number(),
		blockCount: v.number()
	})
		.index('by_companyId', ['companyId'])
		.index('by_contractId', ['contractId'])
		.index('by_stage_receiptId_generation_unit_slot', [
			'stage.receiptId',
			'stage.generation',
			'stage.unit',
			'stage.slot'
		]),
	contractDocumentChunks: defineTable({
		companyId: v.id('company'),
		contractId: v.id('savedContracts'),
		fingerprint: v.string(),
		data: v.bytes()
	})
		.index('by_companyId', ['companyId'])
		.index('by_contractId', ['contractId']),
	// Bounded, reusable validation data for an exact published document revision.
	discussionPassageIndexes: defineTable({
		companyId: v.id('company'),
		contractId: v.id('savedContracts'),
		documentId: v.id('contractDocuments'),
		documentRevision: v.number(),
		manifestSeal: v.string(),
		data: v.bytes()
	})
		.index('by_documentId_and_documentRevision', ['documentId', 'documentRevision'])
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	contractChanges: defineTable(storedContractChange)
		.index('by_stage_receiptId_generation_unit_slot', [
			'stage.receiptId',
			'stage.generation',
			'stage.unit',
			'stage.slot'
		])
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	contractChangeHeads: defineTable(storedContractChangeHead)
		.index('by_contractId_and_kind_and_key', ['contractId', 'kind', 'key'])
		.index('by_contractId_and_kind_and_activePlaybook', ['contractId', 'kind', 'activePlaybook'])
		.index('by_contractId_and_kind', ['contractId', 'kind'])
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	contractChangeDecisions: defineTable(storedContractChangeDecision)
		.index('by_stage_receiptId_generation_unit_slot', [
			'stage.receiptId',
			'stage.generation',
			'stage.unit',
			'stage.slot'
		])
		.index('by_changeId_and_decidedAt', ['changeId', 'decidedAt'])
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	contractChangeContents: defineTable(storedChangeContent)
		.index('by_changeId_and_order', ['changeId', 'order'])
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	contractHubspotAssociations: defineTable(storedContractHubspotAssociation)
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId'])
		.index('by_companyId_and_connectionId_and_dealId', ['companyId', 'connectionId', 'dealId']),
	contractBuyerRefreshes: defineTable(contractBuyerRefresh)
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	// Derived by contractDirectory.writeDirectory; one row per contract. Browsing avoids growing application state.
	contractDirectory: defineTable({
		contractId: v.id('savedContracts'),
		companyId: v.id('company'),
		creatorId: v.id('profiles'),
		hubspot: v.optional(hubspotLink),
		title: v.string(),
		savedAt: v.number(),
		createdAt: v.number(),
		hasUnreadComment: v.boolean(),
		buyerLinkCreatedAt: v.optional(v.number()),
		// Optional only while existing directory rows are backfilled.
		hasBuyerLink: v.optional(v.boolean())
	})
		.index('by_contractId', ['contractId'])
		.index('by_companyId_and_creatorId_and_createdAt', ['companyId', 'creatorId', 'createdAt'])
		.index('by_companyId_and_hubspot_connectionId_and_hubspot_dealId', [
			'companyId',
			'hubspot.connectionId',
			'hubspot.dealId'
		])
		.index('by_companyId_and_savedAt_and_createdAt', ['companyId', 'savedAt', 'createdAt'])
		.index('by_companyId_hasBuyerLink_hasUnreadComment_buyerLinkCreatedAt', [
			'companyId',
			'hasBuyerLink',
			'hasUnreadComment',
			'buyerLinkCreatedAt'
		])
		.searchIndex('search_title', {
			searchField: 'title',
			filterFields: ['companyId', 'hasBuyerLink']
		}),
	buyerLinkBrowseBackfills: defineTable({
		key: v.literal('directory'),
		completedAt: v.number()
	}).index('by_key', ['key']),
	// Latest request per contract and context; immutable delivery evidence lives separately.
	approvalRequests: defineTable(storedApprovalRequest)
		.index('by_contractId_and_context', ['contractId', 'context'])
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	// Survives contract deletion: retry must never resurrect a deleted contract.
	contractCreationReceipts: defineTable({
		retryUntil: v.number(),
		gcAfter: v.number(),
		inputs: v.string(),
		companyId: v.id('company'),
		operationId: v.string(),
		contractId: v.id('savedContracts'),
		// Kept optional for receipt rows written before version freezing moved onto
		// the template itself. New receipts no longer need a reverse lookup.
		templateVersionId: v.optional(v.id('templateVersions'))
	})
		.index('by_gcAfter', ['gcAfter'])
		.index('by_operationId', ['operationId'])
		.index('by_companyId', ['companyId']),
	contractCleanups: defineTable({
		companyId: v.id('company'),
		contractId: v.id('savedContracts'),
		phase: contractCleanupPhase,
		retentionComplete: v.optional(v.literal(true)),
		retentionOwnersDone: v.optional(v.literal(true)),
		retentionPhase: v.optional(
			v.union(
				v.literal('receipts'),
				v.literal('outputs'),
				v.literal('attempts'),
				v.literal('providers')
			)
		),
		retentionCursor: v.optional(v.string()),
		retentionProof: v.optional(
			v.object({
				outputId: v.id('contractOutputs'),
				section: v.literal('output-proof'),
				generation: v.number(),
				cursor: outputProofCursor
			})
		),
		retentionDocumentId: v.optional(v.id('contractDocuments')),
		retentionChunkOffset: v.optional(v.number()),
		retentionBytes: v.optional(v.number()),
		retentionReadBytes: v.optional(v.number()),
		providerCursor: v.optional(v.string()),
		waitingDueAt: v.optional(v.number()),
		generation: v.number(),
		jobId: v.optional(v.id('_scheduled_functions'))
	})
		.index('by_contractId', ['contractId'])
		.index('by_waitingDueAt', ['waitingDueAt'])
		.index('by_companyId', ['companyId']),

	// Email delivery
	emailDeliveries: defineTable(emailDelivery)
		.index('by_snapshot_receiptId', ['snapshot.receiptId'])
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
	// Ordered, bounded selection chunks owned by one delivery.
	emailSelectionChunks: defineTable({
		companyId: v.id('company'),
		deliveryId: v.id('emailDeliveries'),
		generation: v.number(),
		order: v.number(),
		entries: v.array(nativeEmailEntry),
		fingerprint: v.string(),
		previousHash: v.string(),
		hash: v.string(),
		bytes: v.number()
	})
		.index('by_deliveryId_and_order', ['deliveryId', 'order'])
		.index('by_deliveryId_and_generation_and_order', ['deliveryId', 'generation', 'order'])
		.index('by_companyId', ['companyId']),

	// Account and storage maintenance
	deletedUsers: defineTable(deletedUser)
		.index('by_issuer_and_clerkId', ['issuer', 'clerkId'])
		.index('by_profileId', ['profileId'])
		.index('by_complete', ['complete']),
	companyDeletions: defineTable(companyDeletion)
		.index('by_companyId', ['companyId'])
		.index('by_issuer_and_clerkId', ['issuer', 'clerkId'])
		.index('by_status_and_requestedAt', ['status', 'requestedAt']),
	fileSweeps: defineTable({
		kind: v.literal('storage-orphans'),
		completedThrough: v.union(v.number(), v.null()),
		active: v.union(
			v.object({ cutoff: v.number(), cursor: v.union(v.string(), v.null()) }),
			v.null()
		)
	}).index('by_kind', ['kind'])
});
