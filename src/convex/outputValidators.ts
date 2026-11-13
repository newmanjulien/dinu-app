import { v, type Infer } from 'convex/values';
import { sourceExpectation } from './contractSourceValidators';
import { changeActor } from '../lib/contract/changes';
import { hubspotDestination } from './hubspotValidators';

export const outputProof = v.object({
	receiptId: v.id('operationReceipts'),
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
/** Concrete original-receipt traversal. Cursors never contain a collection of heads. */
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
