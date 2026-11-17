import { v, type Infer } from 'convex/values';
import {
	transitionManifest,
	unreadProofCursor,
	supportProofCursor
} from './discussionIndexValidators';

export const nativeConstruction = v.object({
	tapeLength: v.optional(v.number()),
	phase: v.union(
		...(
			[
				'initialize',
				'command',
				'reverse',
				'patch',
				'compare',
				'compare-own',
				'finish',
				'seal',
				'state',
				'geometry',
				'sealed'
			] as const
		).map((kind) => v.literal(kind))
	),
	documentId: v.id('contractDocuments'),
	baseDocumentId: v.optional(v.id('contractDocuments')),
	candidateDocumentId: v.optional(v.id('contractDocuments')),
	comparisonDocumentId: v.optional(v.id('contractDocuments')),
	changeId: v.optional(v.id('contractChanges')),
	predecessorId: v.optional(v.id('contractChanges')),
	ancestors: v.array(v.id('contractChanges')),
	command: v.number(),
	commandHash: v.string(),
	commandBytes: v.number(),
	commandRecords: v.number(),
	cursor: v.number(),
	headCount: v.number(),
	dirtyCount: v.number(),
	headsHash: v.string(),
	headsBytes: v.number(),
	stateCursor: v.union(v.string(), v.null()),
	stateRecords: v.number(),
	stateHash: v.string(),
	stateBytes: v.number(),
	playbookSelectionCount: v.number(),
	playbookReviewCount: v.number(),
	playbookPendingCount: v.number(),
	playbookDeclinedCount: v.number(),
	contextChanged: v.boolean(),
	documentChanged: v.boolean(),
	changeIds: v.array(v.id('contractChanges')),
	decisionIds: v.array(v.id('contractChangeDecisions')),
	identity: v.string()
});

/** Original server-resolved identity survives pending, completion and failure. Never a public argument. */
export const preparationActor = v.union(
	v.object({
		kind: v.literal('seller'),
		membershipId: v.id('memberships'),
		profileId: v.id('profiles'),
		identity: v.string(),
		role: v.union(v.literal('rep'), v.literal('admin')),
		link: v.optional(v.object({ id: v.id('buyerLinks'), token: v.string() }))
	}),
	v.object({
		kind: v.literal('buyer'),
		accountIdentity: v.optional(v.string()),
		browserId: v.string(),
		actorKey: v.string(),
		linkId: v.id('buyerLinks'),
		token: v.string()
	})
);
export const nativePreparationKind = v.union(
	v.literal('playbook-save'),
	v.literal('change-decision'),
	v.literal('proposal-support'),
	v.literal('approval-request'),
	v.literal('review-completion'),
	v.literal('discussion-write'),
	v.literal('discussion-mark-seen')
);
/** This seals immutable inputs only. Native construction and adoption remain separate. */
export const nativeValidation = v.object({
	build: v.optional(nativeConstruction),
	generation: v.number(),
	unit: v.number(),
	phase: v.union(
		v.literal('targets'),
		v.literal('playbook'),
		v.literal('sources'),
		v.literal('validated'),
		v.literal('constructing'),
		v.literal('sealed')
	),
	commandCursor: v.number(),
	playbookCursor: v.union(v.string(), v.null()),
	activePlaybookCount: v.number(),
	records: v.number(),
	recordsBytes: v.number(),
	recordsHash: v.string(),
	sourceDocumentValidated: v.boolean(),
	sourceRecord: v.number(),
	sourceRoot: v.number(),
	ancestorId: v.optional(v.id('contractChanges')),
	ancestorIds: v.array(v.id('contractChanges')),
	sourceRecords: v.number(),
	sourceBytes: v.number(),
	sourceHash: v.string(),
	jobId: v.optional(v.id('_scheduled_functions'))
});
export function initialNativeValidation(
	generation: number,
	identity: string
): Infer<typeof nativeValidation> {
	return {
		generation,
		unit: 0,
		phase: 'targets',
		commandCursor: 0,
		playbookCursor: null,
		activePlaybookCount: 0,
		records: 0,
		recordsBytes: 0,
		recordsHash: identity,
		sourceDocumentValidated: false,
		sourceRecord: 0,
		sourceRoot: 0,
		ancestorIds: [],
		sourceRecords: 0,
		sourceBytes: 0,
		sourceHash: identity
	};
}
export const sourcePassage = v.object({
	inputHash: v.string(),
	documentId: v.id('contractDocuments'),
	documentRevision: v.number(),
	manifestSeal: v.string(),
	start: v.number(),
	end: v.number(),
	tapeLength: v.number()
});
export const discussionPreparation = v.object({
	sourcePassage: v.optional(sourcePassage),
	passageJobId: v.optional(v.id('_scheduled_functions')),
	native: v.optional(nativeValidation),
	nativeGeneration: v.number(),
	nativePlanPending: v.boolean(),
	sourceDocumentId: v.id('contractDocuments'),
	sourceDocumentRevision: v.number(),
	nativeStateRevision: v.number(),
	planIdentity: v.string(),
	proofIdentity: v.string(),
	map: v.optional(transitionManifest),
	mapCursor: v.optional(
		v.object({
			splice: v.number(),
			chunkCount: v.number(),
			bytes: v.number(),
			displacement: v.number(),
			hash: v.string()
		})
	),
	proofCursor: unreadProofCursor,
	indexGeneration: v.number(),
	proofComplete: v.boolean(),
	supportCursor: supportProofCursor,
	supportComplete: v.boolean(),
	supportGeneration: v.number(),
	storageGeneration: v.number(),
	requestId: v.union(v.id('approvalRequests'), v.null()),
	requestCutoff: v.union(v.number(), v.null()),
	witnessThreadId: v.union(v.id('discussionThreads'), v.null()),
	restartGeneration: v.number(),
	dueAt: v.number()
});
