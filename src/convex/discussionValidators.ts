import { v } from 'convex/values';
import { discussionAnchor } from '../lib/discussions/validators';
const ownership = { companyId: v.id('company'), contractId: v.id('savedContracts') };
export const storedThread = v.object({
	...ownership,
	anchor: discussionAnchor,
	type: v.union(v.literal('comment'), v.literal('proposal')),
	applied: v.boolean()
});
export const storedMessage = v.object({
	...ownership,
	threadId: v.id('discussionThreads'),
	reply: v.boolean(),
	authorKey: v.string(),
	profileId: v.optional(v.id('profiles')),
	text: v.string(),
	revision: v.number(),
	deleted: v.boolean(),
	createdAt: v.number()
});
export const storedReceipt = v.object({
	...ownership,
	actorKey: v.string(),
	operationId: v.string(),
	fingerprint: v.string(),
	threadId: v.id('discussionThreads'),
	messageId: v.id('discussionMessages')
});
