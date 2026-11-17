import { v } from 'convex/values';
import { discussionAnchor } from '../lib/discussions/validators';
const ownership = {
	companyId: v.id('company'),
	contractId: v.id('savedContracts')
};
export const storedThread = v.object({
	...ownership,
	anchor: discussionAnchor,
	unreadKey: v.optional(v.string()),
	contentIdentity: v.string(),
	contentRevision: v.number(),
	indexedDocumentRevision: v.number(),
	indexedTapeLength: v.number(),
	passageStart: v.number(),
	passageEnd: v.number(),
	unreadMessageCount: v.number(),
	tombstoned: v.boolean(),
	cleanupDueAt: v.optional(v.number()),
	cleanupPhase: v.optional(
		v.union(v.literal('messages'), v.literal('receipts'), v.literal('done'))
	),
	type: v.union(v.literal('comment'), v.literal('proposal'))
});
export const storedMessage = v.object({
	...ownership,
	threadId: v.id('discussionThreads'),
	reply: v.boolean(),
	authorKey: v.string(),
	operationId: v.optional(v.string()),
	profileId: v.optional(v.id('profiles')),
	text: v.string(),
	revision: v.number(),
	deleted: v.boolean(),
	unreadByTeam: v.boolean()
});
export const storedReceipt = v.object({
	retryUntil: v.number(),
	gcAfter: v.number(),
	...ownership,
	actorKey: v.string(),
	operationId: v.string(),
	fingerprint: v.string(),
	threadId: v.id('discussionThreads'),
	messageId: v.id('discussionMessages')
});
