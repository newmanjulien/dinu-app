import { v, type Infer } from 'convex/values';
import { sourcePoint } from '../document/source-validators';

export const discussionPoint = v.union(
	v.object({ kind: v.literal('source'), point: sourcePoint }),
	v.object({
		kind: v.literal('concession'),
		itemId: v.id('playbookItems'),
		concessionId: v.string(),
		changeIndex: v.number(),
		offset: v.number()
	})
);
export const discussionAnchor = v.object({
	start: discussionPoint,
	end: discussionPoint,
	quote: v.string()
});
export const discussionFootprint = v.object({
	templateStart: v.optional(v.number()),
	templateEnd: v.optional(v.number()),
	blockSpan: v.optional(v.object({ start: v.number(), end: v.number() })),
	blockKeys: v.array(v.string()),
	concessions: v.array(
		v.object({
			itemId: v.id('playbookItems'),
			concessionId: v.string()
		})
	)
});
export type DiscussionPoint = Infer<typeof discussionPoint>;
export type DiscussionAnchor = Infer<typeof discussionAnchor>;
export type DiscussionFootprint = Infer<typeof discussionFootprint>;

export const discussionAccess = v.object({ token: v.string() });
export type DiscussionAccess = Infer<typeof discussionAccess>;

export const discussionCommand = v.union(
	v.object({
		kind: v.literal('create'),
		anchor: discussionAnchor,
		contentRevision: v.number(),
		text: v.string()
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
		expectedRevision: v.number(),
		target: v.union(v.literal('thread'), v.literal('reply'))
	})
);
export type DiscussionCommand = Infer<typeof discussionCommand>;

export const publicAuthor = v.object({
	key: v.string(),
	name: v.string(),
	avatarUrl: v.union(v.string(), v.null()),
	buyer: v.boolean()
});
export type PublicAuthor = Infer<typeof publicAuthor>;

export const discussionMessage = v.object({
	id: v.id('discussionMessages'),
	text: v.string(),
	revision: v.number(),
	author: publicAuthor,
	createdAt: v.number(),
	operationId: v.union(v.string(), v.null())
});
export type DiscussionMessage = Infer<typeof discussionMessage>;

export const discussionThread = v.object({
	id: v.id('discussionThreads'),
	contentRevision: v.number(),
	anchor: discussionAnchor,
	root: discussionMessage
});
export type DiscussionThread = Infer<typeof discussionThread>;

export const writeResult = v.object({
	status: v.literal('complete'),
	operationId: v.string(),
	threadId: v.id('discussionThreads'),
	messageId: v.id('discussionMessages')
});
export type DiscussionWriteResult = Infer<typeof writeResult>;

export const seenMessages = v.array(
	v.object({ messageId: v.id('discussionMessages'), revision: v.number() })
);

export const markSeenResult = v.object({
	status: v.literal('complete'),
	operationId: v.string()
});
