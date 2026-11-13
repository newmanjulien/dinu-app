import { v } from 'convex/values';

/** Private construction ownership; never grants public access to an immutable row. */
export const nativeStage = v.object({
	receiptId: v.id('operationReceipts'),
	generation: v.number(),
	unit: v.number(),
	slot: v.string(),
	sealed: v.boolean(),
	written: v.number(),
	bytes: v.optional(v.number()),
	hashes: v.optional(v.array(v.string())),
	fingerprint: v.optional(v.string())
});
export const nativeResult = v.object({
	generation: v.number(),
	identity: v.string(),
	documentId: v.id('contractDocuments'),
	changeIds: v.array(v.id('contractChanges')),
	decisionIds: v.array(v.id('contractChangeDecisions'))
});
export const nativeCleanup = v.object({
	generation: v.number(),
	through: v.number(),
	phase: v.union(
		v.literal('documents'),
		v.literal('changes'),
		v.literal('decisions'),
		v.literal('chunks')
	),
	cursor: v.union(v.string(), v.null()),
	documentId: v.optional(v.id('contractDocuments')),
	changeId: v.optional(v.id('contractChanges')),
	offset: v.number(),
	phaseDone: v.optional(v.boolean()),
	dueAt: v.number(),
	jobId: v.optional(v.id('_scheduled_functions'))
});
