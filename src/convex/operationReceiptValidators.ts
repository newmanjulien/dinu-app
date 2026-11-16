import { v } from 'convex/values';
import { discussionPreparation, preparationActor } from './discussionPreparationValidators';
import { nativeResult, nativeCleanup } from './nativeStageValidators';
import { emailPreparation } from './nativeEmailValidators';
/** Immutable retry deadline; physical disposal waits for independent owners and cleanup. */
export const operationReceipt = v.object({
	retryUntil: v.number(),
	// Immutable minimum of the outer deadline and independently replayable commands.
	executionUntil: v.number(),
	gcAfter: v.number(),
	// Set only after every dependency has released the original owner/seal.
	collecting: v.optional(v.literal(true)),
	errorCode: v.optional(v.literal('OPERATION_EXPIRED')),
	outputId: v.optional(v.id('contractOutputs')),
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
	companyId: v.id('company'),
	contractId: v.optional(v.id('savedContracts')),
	key: v.string(),
	inputs: v.string(),
	chunked: v.optional(v.boolean()),
	result: v.string()
});
