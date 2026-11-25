import { templateAudience, templateItem } from '../lib/playbook/validators';
import { VALIDATION_CODEC_VERSION } from '../lib/document/validation-codec';
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { sourceBlock } from '../lib/document/source-validators';
import { storedTemplateSource } from './templateSourceValidators';
import { storedSetupIntake } from './templateSetupValidators';
import { contractCleanupPhase } from './contractCleanupValidators';
import {
	storedContract,
	storedContractHubspotAssociation,
	contractBuyerRefresh
} from './contractValidators';
import { companyDeletion, deletedUser } from './deletionValidators';
import { emailDelivery } from './emailValidators';
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
import { storedWordExport } from './exportValidators';
import { hubspotExportDelivery } from './hubspotExportDeliveryValidators';
import { quoteInstallation, quotePush } from './hubspotQuoteValidators';
import { buyerLink } from './buyerValidators';
import { storedThread, storedMessage } from './discussionValidators';
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
	// Flat operation replay receipts; contracts.create, hubspotDeals, and hubspotQuotes check
	// receipts before contract existence. All receipts self-expire in 24h and are wiped on companyDeletion.
	operationReceipts: defineTable(operationReceipt)
		.index('by_key', ['key'])
		.index('by_companyId', ['companyId'])
		.index('by_expiresAt', ['expiresAt']),
	hubspotExportDeliveries: defineTable(hubspotExportDelivery)
		.index('by_companyId', ['companyId'])
		.index('by_attemptId', ['attemptId'])
		.index('by_destination_connectionId', ['destination.connectionId']),
	wordExports: defineTable(storedWordExport)
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId'])
		.index('by_key', ['key'])
		.index('by_fileId', ['fileId'])
		.index('by_expiresAt', ['expiresAt']),

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
		setupIntake: v.optional(storedSetupIntake)
	})
		.index('by_ownerProfileId', ['ownerProfileId'])
		.index('by_avatarId', ['avatarId']),
	// One membership per profile, enforced by the indexed transactional join. Role belongs here.
	memberships: defineTable({
		profileId: v.id('profiles'),
		companyId: v.id('company'),
		setupCompletedAt: v.optional(v.number()),
		firstBuyerLinkHintShowing: v.optional(v.object({ visitId: v.string(), shownAt: v.number() })),
		supportWidgetCollapsed: v.boolean(),
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
	playbookItems: defineTable(storedTemplateItem)
		.index('by_companyId', ['companyId'])
		.index('by_companyId_and_audience', ['companyId', 'audience']),
	// Historical item IDs remain valid after the live item is deleted.
	playbookItemRevisions: defineTable({
		companyId: v.id('company'),
		itemId: v.id('playbookItems'),
		itemCreatedAt: v.number(),
		contentRevision: v.number(),
		body: templateItem,
		lastOperation: v.optional(v.object({ id: v.string(), callerId: v.id('profiles') })),
		renderKey: v.string(),
		// A mutable template version owns these revisions until a contract freezes it.
		mutableVersionId: v.optional(v.id('templateVersions'))
	}).index('by_companyId', ['companyId']),
	templateVersions: defineTable({
		companyId: v.id('company'),
		templateSourceId: v.id('templateSources'),
		items: v.array(
			v.object({
				itemId: v.id('playbookItems'),
				revisionId: v.id('playbookItemRevisions'),
				audience: templateAudience
			})
		),
		// First contract capture freezes this version permanently, even if the contract is deleted.
		mutability: v.union(v.literal('mutable'), v.literal('frozen')),
		updatedAt: v.number(),
		// Derived admission accounting, maintained atomically when saving the version.
		blockCount: v.number(),
		itemCount: v.number(),
		snapshotBytes: v.number(),
		contentReadBytes: v.number(),
		headReadBytes: v.number(),
		structureResultBytes: v.number(),
		authoringGeneration: v.number(),
		structuralGeneration: v.number(),
		validation: v.object({
			format: v.union(v.literal(0), v.literal(VALIDATION_CODEC_VERSION)),
			fingerprint: v.string()
		})
	}).index('by_companyId', ['companyId']),

	// One pointer per company, enforced by the template version writer.
	currentTemplate: defineTable({
		companyId: v.id('company'),
		versionId: v.id('templateVersions')
	}).index('by_companyId', ['companyId']),
	// Survives item deletion: retry must never recreate a deleted item.
	playbookItemCreationReceipts: defineTable({
		companyId: v.id('company'),
		renderKey: v.string(),
		operationId: v.string(),
		itemId: v.id('playbookItems')
	})
		.index('by_operationId', ['operationId'])
		.index('by_companyId_and_renderKey', ['companyId', 'renderKey'])
		.index('by_companyId', ['companyId']),

	// Permanent buyer link with auto-synced approved-concessions view.
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
	discussionThreads: defineTable(storedThread)
		.index('by_contractId', ['contractId'])
		.index('by_contractId_and_hasUnread', ['contractId', 'hasUnread'])
		.index('by_companyId', ['companyId']),
	discussionMessages: defineTable(storedMessage)
		.index('by_threadId_and_reply', ['threadId', 'reply'])
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),

	// Contracts
	savedContracts: defineTable(storedContract).index('by_companyId', ['companyId']),
	contractHubspotAssociations: defineTable(storedContractHubspotAssociation)
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId'])
		.index('by_companyId_and_connectionId_and_dealId', ['companyId', 'connectionId', 'dealId']),
	contractBuyerRefreshes: defineTable(contractBuyerRefresh)
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	// Derived by contractDirectory.writeDirectory; one row per contract.
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
		hasBuyerLink: v.boolean()
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
	contractCleanups: defineTable({
		companyId: v.id('company'),
		contractId: v.id('savedContracts'),
		phase: contractCleanupPhase,
		cursor: v.optional(v.string()),
		waitingDueAt: v.optional(v.number()),
		generation: v.number(),
		jobId: v.optional(v.id('_scheduled_functions'))
	})
		.index('by_contractId', ['contractId'])
		.index('by_waitingDueAt', ['waitingDueAt'])
		.index('by_companyId', ['companyId']),

	// Email delivery
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
		]),

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
