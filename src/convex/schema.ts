import { templateItem } from '../lib/playbook/validators';
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { sourceBlock } from '../lib/document/source-validators';
import { storedTemplateSource } from './templateSourceValidators';
import { contractCleanupPhase } from './contractCleanupValidators';
import { storedApprovalRequest, storedContract, storedDecision } from './contractValidators';
import { companyDeletion, deletedUser } from './deletionValidators';
import { emailDelivery, emailSelection } from './emailValidators';
import { storedInvitation } from './invitationValidators';
import {
	hubspotLink,
	hubspotConnection,
	hubspotOAuthState,
	hubspotEvent,
	hubspotReceipt,
	hubspotExport,
	hubspotExportChunk,
	hubspotRemoval,
	hubspotAccountRemoval
} from './hubspotValidators';
import { role } from './permissions';
import { quoteInstallation, quotePush } from './hubspotQuoteValidators';
import { buyerLink, buyerState } from './buyerValidators';
import { storedThread, storedMessage, storedReceipt } from './discussionValidators';
import { contractConcession } from './contractItemValidators';
import {
	opening,
	activityVisit,
	activityQuotaKey,
	discussionQuotaKey,
	activityOpening,
	activityReceipt,
	distinctClause
} from './buyerActivityValidators';
import { storedCsmAttempt } from './csmBookingValidators';
import { storedSetupAppointment } from './csmSetupValidators';
import { storedPlaybookItem } from './playbookValidators';
/** Domain map: docs/data-model.md. Child company IDs support authorization and bounded cleanup. */
export default defineSchema({
	contractAccess: defineTable({
		companyId: v.id('company'),
		contractId: v.id('savedContracts'),
		templateVersionId: v.id('templateVersions')
	})
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	hubspotLinkBlocks: defineTable({
		companyId: v.id('company'),
		contractId: v.id('savedContracts'),
		generation: v.number()
	})
		.index('by_companyId', ['companyId'])
		.index('by_contractId_and_generation', ['contractId', 'generation']),
	hubspotQuoteInstallations: defineTable(quoteInstallation).index('by_companyId', ['companyId']),
	hubspotQuotePushes: defineTable(quotePush)
		.index('by_companyId', ['companyId'])
		.index('by_contractId', ['contractId'])
		.index('by_contractId_and_requestedAt', ['contractId', 'requestedAt'])
		.index('by_canonicalKey', ['canonicalKey'])
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
		.index('by_companyId', ['companyId'])
		.index('by_destination_connectionId', ['destination.connectionId'])
		.index('by_key', ['key'])
		.index('by_status_and_dueAt', ['status', 'dueAt']),
	hubspotReceipts: defineTable(hubspotReceipt)
		.index('by_companyId', ['companyId'])
		.index('by_key', ['key']),
	hubspotReceiptChunks: defineTable({
		companyId: v.id('company'),
		receiptId: v.id('hubspotReceipts'),
		order: v.number(),
		data: v.string()
	})
		.index('by_companyId', ['companyId'])
		.index('by_receiptId_and_order', ['receiptId', 'order']),
	hubspotExports: defineTable(hubspotExport)
		.index('by_companyId', ['companyId'])
		.index('by_destination_connectionId', ['destination.connectionId'])
		.index('by_key', ['key'])
		.index('by_fileId', ['fileId'])
		.index('by_state_and_expiresAt', ['state', 'expiresAt']),
	hubspotExportChunks: defineTable(hubspotExportChunk)
		.index('by_companyId', ['companyId'])
		.index('by_attemptId_and_order', ['attemptId', 'order']),
	// Accounts and companies
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
	// A missing owner permits operator recovery; a missing templateSource means setup is incomplete.
	company: defineTable({
		ownerProfileId: v.optional(v.id('profiles')),
		approvalEmail: v.optional(v.string()),
		name: v.string(),
		avatarId: v.optional(v.id('_storage')),
		templateSourceId: v.optional(v.id('templateSources')),
		colleaguesInvitedAt: v.optional(v.number()),
		csmCallBookedAt: v.optional(v.number()),
		authoringMigration: v.optional(v.boolean())
	})
		.index('by_ownerProfileId', ['ownerProfileId'])
		.index('by_avatarId', ['avatarId']),
	// One membership per profile, enforced by the indexed transactional join. Role belongs here.
	memberships: defineTable({
		profileId: v.id('profiles'),
		companyId: v.id('company'),
		buyerLinkCopiedAt: v.optional(v.number()),
		setupCompletedAt: v.optional(v.number()),
		role
	})
		.index('by_profileId', ['profileId'])
		.index('by_companyId', ['companyId']),
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
	csmBookingAttempts: defineTable(storedCsmAttempt)
		.index('by_membershipId_and_operationId', ['membershipId', 'operationId'])
		.index('by_membershipId_and_state', ['membershipId', 'state'])
		// Temporary admission fence until historical failures have explicit noncreation evidence.
		.index('by_membershipId_and_state_and_failureBasis', ['membershipId', 'state', 'failureBasis'])
		.index('by_companyId', ['companyId'])
		.index('by_profileId', ['profileId']),
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
	playbookItems: defineTable(storedPlaybookItem).index('by_companyId', ['companyId']),
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

	// A permanent buyer link and its separately released publication.
	buyerLinks: defineTable(buyerLink)
		.index('by_token', ['token'])
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	buyerActivityOpenings: defineTable(activityOpening)
		.index('by_contractId_and_openingId', ['contractId', 'openingId'])
		.index('by_contractId_and_expiresAt', ['contractId', 'expiresAt'])
		.index('by_contractId_and_browserId_and_acceptedAt', ['contractId', 'browserId', 'acceptedAt'])
		.index('by_expiresAt', ['expiresAt'])
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	buyerActivityReceipts: defineTable(activityReceipt)
		.index('by_contractId_and_eventId', ['contractId', 'eventId'])
		.index('by_openingId_and_itemId', ['openingId', 'itemId'])
		.index('by_expiresAt', ['expiresAt'])
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	// Historical membership rows remain admitted/drained until verified empty.
	buyerActivityClauses: defineTable(distinctClause)
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
	// Legacy raw history/projections are read only by explicit retirement and deletion.
	buyerLinkOpens: defineTable(opening)
		.index('by_companyId', ['companyId'])
		.index('by_profileId', ['profileId'])
		.index('by_visitorKey', ['visitorKey'])
		.index('by_contractId_and_at', ['contractId', 'at'])
		.index('by_contractId_and_visitorNumber_and_projected_and_at', [
			'contractId',
			'visitorNumber',
			'projected',
			'at'
		])
		.index('by_activityVisitId_and_clauseId', ['activityVisitId', 'clauseId'])
		.index('by_contractId_and_visitorNumber', ['contractId', 'visitorNumber'])
		.index('by_contractId_and_visitorKey_and_visitorNumber', [
			'contractId',
			'visitorKey',
			'visitorNumber'
		])
		.index('by_contractId_and_openingId', ['contractId', 'openingId']),
	buyerVisits: defineTable(activityVisit)
		.index('by_companyId', ['companyId'])
		.index('by_profileId', ['profileId'])
		.index('by_contractId_and_lastAt', ['contractId', 'lastAt'])
		.index('by_contractId_and_visitorNumber_and_startedAt', [
			'contractId',
			'visitorNumber',
			'startedAt'
		]),
	buyerActivityQuotaKeys: defineTable(activityQuotaKey)
		.index('by_name_and_key', ['name', 'key'])
		.index('by_expiresAt', ['expiresAt'])
		.index('by_companyId', ['companyId'])
		.index('by_contractId', ['contractId']),
	// Retired analytics: schema/deletion compatibility until removeActivityAnalytics completes.
	buyerLinkStats: defineTable({
		companyId: v.id('company'),
		contractId: v.id('savedContracts'),
		linkId: v.union(v.id('buyerLinks'), v.null()),
		opens: v.number(),
		browsers: v.number(),
		firstOpenedAt: v.optional(v.number()),
		lastOpenedAt: v.optional(v.number())
	})
		.index('by_companyId', ['companyId'])
		.index('by_contractId_and_linkId', ['contractId', 'linkId']),
	buyerLinkBrowsers: defineTable({
		companyId: v.id('company'),
		contractId: v.id('savedContracts'),
		browserId: v.string(),
		number: v.number()
	})
		.index('by_companyId', ['companyId'])
		.index('by_contractId_and_browserId', ['contractId', 'browserId']),
	contractBuyerState: defineTable(buyerState)
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),

	proposalApplications: defineTable({
		companyId: v.id('company'),
		contractId: v.id('savedContracts'),
		threadId: v.id('discussionThreads'),
		revision: v.number(),
		proposalText: v.string(),
		prefixAtoms: v.number(),
		itemId: v.id('contractConcessions')
	})
		.index('by_threadId_and_revision', ['threadId', 'revision'])
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	discussionThreads: defineTable(storedThread)
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	discussionMessages: defineTable(storedMessage)
		.index('by_threadId_and_reply', ['threadId', 'reply'])
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	discussionReceipts: defineTable(storedReceipt)
		.index('by_contractId_and_actorKey_and_operationId', ['contractId', 'actorKey', 'operationId'])
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	contractConcessions: defineTable(contractConcession)
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	publicationAcknowledgments: defineTable({
		companyId: v.id('company'),
		contractId: v.id('savedContracts'),
		profileId: v.id('profiles')
	})
		.index('by_contractId_and_profileId', ['contractId', 'profileId'])
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),

	// Contracts and approvals
	savedContracts: defineTable(storedContract)
		.index('by_companyId', ['companyId'])
		.index('by_companyId_and_hubspot_connectionId_and_hubspot_dealId', [
			'companyId',
			'hubspot.connectionId',
			'hubspot.dealId'
		]),
	// Derived by contractDirectory.writeDirectory; one row per contract. Browsing avoids growing application state.
	contractDirectory: defineTable({
		contractId: v.id('savedContracts'),
		companyId: v.id('company'),
		creatorId: v.id('profiles'),
		hubspot: v.optional(hubspotLink),
		buyerCompanyName: v.string(),
		savedAt: v.number(),
		createdAt: v.number(),
		// Retired eligibility flag; removed by removeActivityAnalytics.
		hasBuyerLinks: v.optional(v.boolean())
	})
		.index('by_contractId', ['contractId'])
		.index('by_companyId_and_creatorId', ['companyId', 'creatorId'])
		.index('by_companyId_and_hubspot_connectionId_and_hubspot_dealId', [
			'companyId',
			'hubspot.connectionId',
			'hubspot.dealId'
		])
		.index('by_companyId_and_savedAt_and_createdAt', ['companyId', 'savedAt', 'createdAt'])
		.searchIndex('search_buyerCompanyName', {
			searchField: 'buyerCompanyName',
			filterFields: ['companyId']
		}),
	concessionDecisions: defineTable(storedDecision)
		.index('by_contractId', ['contractId'])
		.index('by_contractId_and_operationId', ['contractId', 'operationId'])
		.index('by_companyId', ['companyId']),
	// Latest request only: one row per contract, not the delivery or decision audit history.
	approvalRequests: defineTable(storedApprovalRequest)
		.index('by_contractId', ['contractId'])
		.index('by_companyId', ['companyId']),
	// Survives contract deletion: retry must never resurrect a deleted contract.
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
	contractCleanups: defineTable({
		companyId: v.id('company'),
		contractId: v.id('savedContracts'),
		phase: contractCleanupPhase,
		generation: v.number(),
		jobId: v.optional(v.id('_scheduled_functions'))
	})
		.index('by_contractId', ['contractId'])
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
		])
		.index('by_disposal_generation', ['disposal.generation']),
	// Ordered, bounded selection chunks owned by one delivery.
	emailSelectionChunks: defineTable({
		companyId: v.id('company'),
		deliveryId: v.id('emailDeliveries'),
		order: v.number(),
		selections: v.array(emailSelection)
	})
		.index('by_deliveryId_and_order', ['deliveryId', 'order'])
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
