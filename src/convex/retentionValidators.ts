import { v } from 'convex/values';

export const retentionPhase = v.union(
	v.literal('operations'),
	v.literal('creations'),
	v.literal('discussions'),
	v.literal('outputs')
);

/** Global traversal state contains no tenant-owned payload or child owner. */
export const retentionSweep = v.object({
	name: v.literal('contracts'),
	version: v.number(),
	dueAt: v.number(),
	capturedNow: v.optional(v.number()),
	phase: retentionPhase,
	cursor: v.union(v.string(), v.null()),
	jobId: v.optional(v.id('_scheduled_functions'))
});

export const retentionTarget = v.union(
	v.object({ kind: v.literal('operations'), id: v.id('operationReceipts') }),
	v.object({ kind: v.literal('creations'), id: v.id('contractCreationReceipts') }),
	v.object({ kind: v.literal('discussions'), id: v.id('discussionReceipts') }),
	v.object({ kind: v.literal('outputs'), id: v.id('contractOutputs') })
);
