import { v } from 'convex/values';

export const discussionOwner = { companyId: v.id('company'), contractId: v.id('savedContracts') };
export const passageBounds = { passageStart: v.number(), passageEnd: v.number() };
export const discussionSplice = v.object({
	beforeStart: v.number(),
	beforeEnd: v.number(),
	afterStart: v.number(),
	afterEnd: v.number()
});
export const transitionManifest = v.object({
	mapKey: v.string(),
	geometryHash: v.string(),
	chunkHash: v.string(),
	spliceCount: v.number(),
	beforeLength: v.number(),
	afterLength: v.number(),
	chunkCount: v.number(),
	bytes: v.number(),
	inline: v.optional(v.array(discussionSplice))
});
export const storedInvalidation = v.object({
	...discussionOwner,
	fromRevision: v.number(),
	toRevision: v.number(),
	map: transitionManifest
});
export const storedMapChunk = v.object({
	...discussionOwner,
	mapKey: v.string(),
	firstBefore: v.number(),
	startingDisplacement: v.number(),
	garbage: v.optional(v.literal(true)),
	splices: v.array(discussionSplice)
});
export const mapGapCursor = v.object({
	chunk: v.union(v.number(), v.null()),
	splice: v.number(),
	before: v.number(),
	after: v.number(),
	done: v.boolean()
});
export const survivingGap = v.object({
	start: v.number(),
	end: v.number(),
	currentStart: v.number(),
	currentEnd: v.number()
});
export const unreadProofCursor = v.object({
	cohort: v.number(),
	frames: v.array(
		v.object({ gap: survivingGap, mapIndex: v.number(), scan: v.optional(mapGapCursor) })
	)
});
export const unreadEntry = v.object({
	orderKey: v.optional(v.string()),
	end: v.number(),
	threadId: v.id('discussionThreads'),
	start: v.number()
});
export const unreadChild = v.object({
	orderKey: v.optional(v.string()),
	nodeId: v.id('discussionUnreadNodes'),
	end: v.number(),
	threadId: v.id('discussionThreads'),
	maximumStart: v.number(),
	witnessThreadId: v.id('discussionThreads')
});
export const supportCounts = v.object({
	supportCount: v.number(),
	pendingCount: v.number(),
	declinedCount: v.number(),
	withAppliedCount: v.number(),
	coveredPendingCount: v.number()
});
export const supportEntry = v.object({
	end: v.number(),
	threadId: v.id('discussionThreads'),
	start: v.number(),
	changeId: v.id('contractChanges'),
	decisionId: v.union(v.id('contractChangeDecisions'), v.null()),
	rootMessageId: v.id('discussionMessages'),
	rootRevision: v.number(),
	status: v.union(v.literal('pending'), v.literal('declined')),
	admissionRevision: v.number(),
	withApplied: v.boolean()
});
export const supportChild = v.object({
	nodeId: v.id('discussionUnreadNodes'),
	end: v.number(),
	threadId: v.id('discussionThreads'),
	minimumStart: v.number(),
	maximumStart: v.number(),
	supportCount: v.number(),
	pendingCount: v.number(),
	declinedCount: v.number(),
	withAppliedCount: v.number(),
	minimumAdmission: v.number(),
	maximumAdmission: v.number()
});
export const supportTreeCursor = v.object({
	frames: v.array(v.object({ nodeId: v.id('discussionUnreadNodes'), position: v.number() }))
});
export const supportProofCursor = v.object({
	geometry: unreadProofCursor,
	tree: v.optional(supportTreeCursor),
	counts: supportCounts
});
export const storedUnreadNode = v.union(
	v.object({
		...discussionOwner,
		lane: v.literal('unread'),
		revision: v.number(),
		kind: v.literal('leaf'),
		entries: v.array(unreadEntry)
	}),
	v.object({
		...discussionOwner,
		lane: v.literal('unread'),
		revision: v.number(),
		kind: v.literal('branch'),
		children: v.array(unreadChild)
	}),
	v.object({
		...discussionOwner,
		lane: v.literal('support'),
		revision: v.number(),
		kind: v.literal('leaf'),
		entries: v.array(supportEntry)
	}),
	v.object({
		...discussionOwner,
		lane: v.literal('support'),
		revision: v.number(),
		kind: v.literal('branch'),
		children: v.array(supportChild)
	})
);
export const unreadCohort = v.object({
	revision: v.number(),
	tapeLength: v.number(),
	rootId: v.id('discussionUnreadNodes'),
	height: v.number()
});
export const storedUnreadControl = v.object({
	...discussionOwner,
	cohorts: v.array(unreadCohort),
	supportCohorts: v.array(unreadCohort),
	supportCounts,
	appliedBuyerCount: v.number(),
	supportGeneration: v.number(),
	storageGeneration: v.number(),
	request: v.optional(v.object({ id: v.id('approvalRequests'), cutoff: v.number() })),
	witnessThreadId: v.union(v.id('discussionThreads'), v.null()),
	generation: v.number(),
	jobId: v.optional(v.id('_scheduled_functions')),
	dueAt: v.optional(v.number()),
	maintenanceGeneration: v.number(),
	cleanupTurn: v.boolean()
});
export const storedPassageClaim = v.object({
	...discussionOwner,
	threadId: v.id('discussionThreads'),
	indexedDocumentRevision: v.number(),
	start: v.number(),
	end: v.number()
});
