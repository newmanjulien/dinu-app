import { v } from 'convex/values';
import { discussionPreparation, preparationActor } from './discussionPreparationValidators';
import { nativeResult, nativeCleanup } from './nativeStageValidators';
import { emailPreparation } from './nativeEmailValidators';
import {
	outputPreparation,
	reservationManifest,
	outputCleanup,
	outputProofCursor
} from './outputValidators';

/** Company-lifetime operation identity and its exact original input/result bytes. */
export const operationReceipt = v.object({
	outputPreparation: v.optional(outputPreparation),
	outputGeneration: v.optional(v.number()),
	reservationManifest: v.optional(reservationManifest),
	outputCleanup: v.optional(outputCleanup),
	outputVerification: v.optional(
		v.object({ generation: v.number(), cursor: outputProofCursor, complete: v.boolean() })
	),
	documentId: v.optional(v.id('contractDocuments')),
	emailPreparation: v.optional(emailPreparation),
	nativeResult: v.optional(nativeResult),
	nativeCleanup: v.optional(nativeCleanup),
	state: v.union(v.literal('preparing'), v.literal('complete'), v.literal('failed')),
	error: v.optional(v.string()),
	actor: v.optional(preparationActor),
	operationId: v.optional(v.string()),
	preparation: v.optional(discussionPreparation),
	kind: v.optional(
		v.union(
			v.literal('output-reservation'),
			v.literal('quote-reservation'),
			v.literal('quote-commit'),
			v.literal('playbook-save'),
			v.literal('change-decision'),
			v.literal('proposal-support'),
			v.literal('approval-request'),
			v.literal('review-completion'),
			v.literal('discussion-write'),
			v.literal('discussion-mark-seen')
		)
	),
	requestedAt: v.optional(v.number()),
	providerOperationId: v.optional(v.id('hubspotQuotePushes')),
	companyId: v.id('company'),
	contractId: v.optional(v.id('savedContracts')),
	key: v.string(),
	inputs: v.string(),
	chunked: v.optional(v.boolean()),
	result: v.string()
});
