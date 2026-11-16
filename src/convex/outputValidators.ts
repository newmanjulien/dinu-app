import { v, type Infer } from 'convex/values';
import { sourceExpectation } from './contractSourceValidators';
import { changeActor } from '../lib/contract/changes';
import { hubspotDestination } from './hubspotValidators';
import { preparationActor } from './discussionPreparationValidators';

export const outputProof = v.object({
	outputId: v.id('contractOutputs'),
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	schema: v.literal(1),
	section: v.literal('output-proof'),
	generation: v.number(),
	chunks: v.number(),
	records: v.number(),
	bytes: v.number(),
	hash: v.string(),
	bindingHash: v.string()
});
export const outputDestination = v.object({
	hubspot: v.union(hubspotDestination, v.null()),
	connectionGeneration: v.union(v.number(), v.null()),
	installationId: v.optional(v.id('hubspotQuoteInstallations')),
	epoch: v.optional(v.number())
});
export const reservationBase = v.object({
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	documentId: v.id('contractDocuments'),
	documentFingerprint: v.string(),
	templateVersionId: v.id('templateVersions'),
	title: v.string(),
	actor: changeActor,
	membershipId: v.id('memberships'),
	requestedAt: v.number(),
	expectedSource: sourceExpectation,
	destination: outputDestination
});
export const reservationManifest = reservationBase.extend({
	identity: v.string(),
	proof: outputProof
});
export type ReservationManifest = Infer<typeof reservationManifest>;
export const outputFence = v.object({
	source: sourceExpectation,
	supportGeneration: v.number(),
	storageGeneration: v.number(),
	destination: outputDestination
});
/** Concrete output-owned traversal. Cursors never contain a collection of heads. */
export const outputPreparation = v.object({
	purpose: v.union(v.literal('reservation'), v.literal('release')),
	generation: v.number(),
	base: reservationBase,
	fence: outputFence,
	phase: v.union(
		v.literal('heads'),
		v.literal('change'),
		v.literal('contents'),
		v.literal('decisions'),
		v.literal('sealed')
	),
	headCursor: v.union(v.string(), v.null()),
	headDone: v.boolean(),
	changeId: v.optional(v.id('contractChanges')),
	depth: v.number(),
	contentOrder: v.number(),
	contentOffset: v.number(),
	decisionCursor: v.union(v.string(), v.null()),
	chunks: v.number(),
	records: v.number(),
	bytes: v.number(),
	hash: v.string(),
	identity: v.string(),
	claim: v.optional(v.string()),
	jobId: v.optional(v.id('_scheduled_functions')),
	dueAt: v.optional(v.number())
});
export type OutputPreparation = Infer<typeof outputPreparation>;
export const outputProofCursor = v.object({
	order: v.number(),
	records: v.number(),
	bytes: v.number(),
	hash: v.string()
});
export type OutputProofCursor = Infer<typeof outputProofCursor>;
export const outputCleanup = v.object({
	generation: v.number(),
	through: v.number(),
	dueAt: v.number(),
	jobId: v.optional(v.id('_scheduled_functions'))
});

/** Historical facts carry no source IDs, exact request bytes or release authority. */
export const compactOutputFact = v.object({
	title: v.string(),
	profileId: v.id('profiles'),
	membershipId: v.id('memberships'),
	requestedAt: v.number(),
	documentFingerprint: v.string(),
	sourceFingerprint: v.string(),
	proofIdentity: v.string(),
	proofHash: v.string(),
	proofBindingHash: v.string(),
	destination: outputDestination,
	attemptId: v.optional(v.id('hubspotExports')),
	filename: v.optional(v.string()),
	sha256: v.optional(v.string()),
	size: v.optional(v.number()),
	releasedAt: v.optional(v.number()),
	acknowledgedAt: v.optional(v.number()),
	acknowledgedOn: v.optional(v.number()),
	delivery: v.optional(
		v.object({
			destination: hubspotDestination,
			state: v.optional(v.union(v.literal('sent'), v.literal('retired'))),
			remoteFileId: v.optional(v.string()),
			noteId: v.optional(v.string())
		})
	)
});
const outputIdentity = {
	companyId: v.id('company'),
	contractId: v.id('savedContracts'),
	kind: v.union(v.literal('output-reservation'), v.literal('quote-reservation')),
	providerOperationId: v.optional(v.id('hubspotQuotePushes'))
};
/** Durable full owner; only this variant can authorize proof, bytes or continuation. */
export const fullContractOutput = v.object({
	...outputIdentity,
	format: v.literal('full'),
	settledAt: v.optional(v.number()),
	committedAt: v.optional(v.number()),
	evidenceUntil: v.optional(v.number()),
	retentionDueAt: v.number(),
	compaction: v.optional(compactOutputFact),
	disposal: v.optional(v.literal(true)),
	documentId: v.id('contractDocuments'),
	state: v.union(v.literal('preparing'), v.literal('complete'), v.literal('failed')),
	receiptId: v.optional(v.id('operationReceipts')),
	key: v.string(),
	operationId: v.string(),
	actor: preparationActor,
	executionUntil: v.number(),
	error: v.optional(v.string()),
	outputPreparation: v.optional(outputPreparation),
	outputGeneration: v.number(),
	reservationManifest: v.optional(reservationManifest),
	manifestHash: v.optional(v.string()),
	outputCleanup: v.optional(outputCleanup),
	outputVerification: v.optional(
		v.object({ generation: v.number(), cursor: outputProofCursor, complete: v.boolean() })
	)
});

export const compactContractOutput = v.object({
	...outputIdentity,
	format: v.literal('compact'),
	state: v.literal('complete'),
	settledAt: v.number(),
	evidenceUntil: v.number(),
	fact: compactOutputFact
});
export const contractOutput = v.union(fullContractOutput, compactContractOutput);
