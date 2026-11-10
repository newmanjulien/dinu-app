import { v, type Infer } from 'convex/values';
import { sourcePoint } from '../document/source-validators';
import { contractItemId } from '../contract/item-identity';
export const discussionOrigin = v.object({
	itemId: contractItemId,
	concessionId: v.string(),
	changeIndex: v.number()
});
export const discussionPoint = v.union(
	v.object({ kind: v.literal('source'), point: sourcePoint }),
	v.object({ kind: v.literal('replacement'), origin: discussionOrigin, offset: v.number() })
);
export const discussionAnchor = v.object({
	start: discussionPoint,
	end: discussionPoint,
	quote: v.string()
});
export type DiscussionAnchor = Infer<typeof discussionAnchor>;
export type DiscussionPoint = Infer<typeof discussionPoint>;
export const discussionCommand = v.union(
	v.object({
		kind: v.literal('create'),
		anchor: discussionAnchor,
		revision: v.number(),
		text: v.string(),
		type: v.union(v.literal('comment'), v.literal('proposal'))
	}),
	v.object({ kind: v.literal('reply'), threadId: v.id('discussionThreads'), text: v.string() }),
	v.object({
		kind: v.literal('edit'),
		messageId: v.id('discussionMessages'),
		expectedRevision: v.number(),
		text: v.string()
	}),
	v.object({
		kind: v.literal('delete'),
		messageId: v.id('discussionMessages'),
		expectedRevision: v.number()
	})
);
export const publicAuthor = v.object({
	key: v.string(),
	name: v.string(),
	avatarUrl: v.union(v.string(), v.null()),
	buyer: v.boolean()
});
export const discussionMessage = v.object({
	id: v.id('discussionMessages'),
	text: v.string(),
	revision: v.number(),
	deleted: v.boolean(),
	author: publicAuthor,
	createdAt: v.number()
});
export const discussionThread = v.object({
	id: v.id('discussionThreads'),
	anchor: discussionAnchor,
	type: v.union(v.literal('comment'), v.literal('proposal')),
	root: discussionMessage,
	applied: v.boolean()
});
export const writeResult = v.object({
	threadId: v.id('discussionThreads'),
	messageId: v.id('discussionMessages')
});
