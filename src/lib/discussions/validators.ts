import { v, type Infer } from 'convex/values';
import { sourcePoint } from '../document/source-validators';
export const discussionPoint = v.object({ kind: v.literal('source'), point: sourcePoint });
export const discussionAnchor = v.object({
	start: discussionPoint,
	end: discussionPoint,
	quote: v.string()
});
export type DiscussionAnchor = Infer<typeof discussionAnchor>;
export type DiscussionPoint = Infer<typeof discussionPoint>;
export const discussionAccess = v.object({ token: v.string() });
export type DiscussionAccess = Infer<typeof discussionAccess>;
export const discussionCommand = v.union(
	v.object({
		kind: v.literal('create'),
		anchor: discussionAnchor,
		revision: v.number(),
		contentIdentity: v.string(),
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
	contentIdentity: v.string(),
	contentRevision: v.number(),
	anchor: discussionAnchor,
	type: v.union(v.literal('comment'), v.literal('proposal')),
	root: discussionMessage
});
export const completedWriteResult = v.object({
	status: v.literal('complete'),
	operationId: v.string(),
	threadId: v.id('discussionThreads'),
	messageId: v.id('discussionMessages')
});

export const preparingDiscussionResult = v.object({
	status: v.literal('preparing'),
	operationId: v.string()
});
export const writeResult = v.union(completedWriteResult, preparingDiscussionResult);
export const seenMessages = v.array(
	v.object({ messageId: v.id('discussionMessages'), revision: v.number() })
);
export const markSeenResult = v.union(
	v.object({ status: v.literal('complete'), operationId: v.string() }),
	preparingDiscussionResult
);
export const discussionOperationResult = v.union(
	v.null(),
	preparingDiscussionResult.extend({ retryUntil: v.number() }),
	v.object({
		status: v.literal('complete'),
		operationId: v.string(),
		retryUntil: v.number(),
		result: v.string()
	}),
	v.object({
		status: v.literal('failed'),
		operationId: v.string(),
		retryUntil: v.number(),
		error: v.string(),
		errorCode: v.optional(v.literal('OPERATION_EXPIRED'))
	})
);
