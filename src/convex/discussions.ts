import { ConvexError, v, type Infer } from 'convex/values';
import {
	paginationOptsValidator,
	paginationResultValidator,
	type PaginationOptions
} from 'convex/server';
import {
	query,
	mutation,
	internalMutation,
	internalQuery,
	type QueryCtx
} from './_generated/server';
import {
	discussionContext,
	ownsDiscussion as owns,
	liveDiscussionThread,
	type DiscussionContext
} from './discussionContext';
export { discussionContext } from './discussionContext';
import {
	discussionAccess,
	discussionCommand,
	discussionThread,
	discussionMessage,
	publicAuthor,
	writeResult,
	seenMessages,
	markSeenResult,
	discussionOperationResult
} from '../lib/discussions/validators';
import { discussionActor, authorView, messageProjector } from './discussionService';
import { writeDiscussion, markDiscussionSeen, discussionResult } from './discussionCommands';
import { requireMembership } from './auth';
import type { Doc } from './_generated/dataModel';

const privateContextArgs = {
	membershipId: v.id('memberships'),
	id: v.id('savedContracts'),
	token: v.string()
};
function boundPage(opts: PaginationOptions): PaginationOptions {
	if (
		opts.numItems > 40 ||
		(opts.maximumRowsRead ?? 50) > 50 ||
		(opts.maximumBytesRead ?? 1_500_000) > 1_500_000
	)
		throw new ConvexError('Use bounded discussion pages.');
	return {
		...opts,
		maximumRowsRead: opts.maximumRowsRead ?? 30,
		maximumBytesRead: opts.maximumBytesRead ?? 1_500_000
	};
}

async function privateContext(
	ctx: QueryCtx,
	args: Infer<typeof discussionAccess> & {
		membershipId: Doc<'memberships'>['_id'];
		id: Doc<'savedContracts'>['_id'];
	}
) {
	const access = await requireMembership(ctx, args.membershipId),
		context = await discussionContext(ctx, args);
	if (context.root._id !== args.id || context.root.companyId !== access.companyId)
		throw new ConvexError('This contract is unavailable.');
	return context;
}
export const threads = query({
	args: { access: discussionAccess, paginationOpts: paginationOptsValidator },
	returns: paginationResultValidator(discussionThread),
	handler: async (ctx, { access, paginationOpts }) => {
		const context = await discussionContext(ctx, access);
		const page = await ctx.db
			.query('discussionThreads')
			.withIndex('by_contractId', (q) => q.eq('contractId', context.root._id))
			.order('asc')
			.paginate(boundPage(paginationOpts));
		const project = threadProjector(ctx, context),
			visible = [];
		for (const thread of page.page)
			if (owns(context, thread) && (await context.index.interval(thread)))
				visible.push(await project(thread));
		// The page owner must continue empty nonterminal pages with the real native
		// cursor/split/pageStatus. One query never scans extra database pages.
		return { ...page, page: visible };
	}
});
export const replies = query({
	args: {
		access: discussionAccess,
		threadId: v.id('discussionThreads'),
		paginationOpts: paginationOptsValidator
	},
	returns: paginationResultValidator(discussionMessage),
	handler: async (ctx, { access, threadId, paginationOpts }) => {
		const { context } = await requireThread(ctx, access, threadId);
		const page = await ctx.db
			.query('discussionMessages')
			.withIndex('by_threadId_and_reply', (q) => q.eq('threadId', threadId).eq('reply', true))
			.paginate(boundPage(paginationOpts));
		return { ...page, page: await Promise.all(page.page.map(messageProjector(ctx, context.root))) };
	}
});
export const viewer = query({
	args: privateContextArgs,
	returns: publicAuthor,
	handler: async (ctx, args) => {
		const context = await privateContext(ctx, args);
		return authorView(ctx, context.root, await discussionActor(ctx, context));
	}
});
export const markSeen = mutation({
	args: { ...privateContextArgs, operationId: v.string(), messages: seenMessages },
	returns: markSeenResult,
	handler: async (ctx, args) => {
		const context = await privateContext(ctx, args);
		return markDiscussionSeen(ctx, context, await discussionActor(ctx, context), {
			token: args.token,
			operationId: args.operationId,
			messages: args.messages
		});
	}
});
export const write = mutation({
	args: { ...privateContextArgs, operationId: v.string(), command: discussionCommand },
	returns: writeResult,
	handler: async (ctx, args) => {
		const context = await privateContext(ctx, args);
		return writeDiscussion(ctx, context, await discussionActor(ctx, context), {
			token: args.token,
			operationId: args.operationId,
			command: args.command
		});
	}
});
const buyerOperationArgs = {
	token: v.string(),
	browserId: v.string(),
	operationId: v.string(),
	expectedAuthorKey: v.string(),
	command: discussionCommand
};
async function buyerOperation(
	ctx: QueryCtx,
	args: Infer<typeof discussionAccess> & { browserId: string; expectedAuthorKey: string }
) {
	const context = await discussionContext(ctx, args),
		actor = await discussionActor(ctx, context, args.browserId);
	// This is a draft precondition; access and the receipt key are derived above.
	if (actor.key !== args.expectedAuthorKey)
		throw new ConvexError({
			code: 'DISCUSSION_IDENTITY_CHANGED',
			message: 'Reconnect as the original author before retrying. Your draft is still here.'
		});
	return { context, actor };
}
/** Only the private secret-authenticated HTTP ingress supplies the HttpOnly cookie. */
export const buyerWrite = internalMutation({
	args: buyerOperationArgs,
	returns: writeResult,
	handler: async (ctx, args) => {
		const { context, actor } = await buyerOperation(ctx, args);
		return writeDiscussion(ctx, context, actor, {
			token: args.token,
			operationId: args.operationId,
			command: args.command
		});
	}
});
export const buyerResult = internalQuery({
	args: buyerOperationArgs,
	returns: discussionOperationResult,
	handler: async (ctx, args) => {
		const { context, actor } = await buyerOperation(ctx, args);
		return discussionResult(ctx, context, actor, {
			token: args.token,
			operationId: args.operationId,
			command: args.command
		});
	}
});
export const buyerViewer = internalQuery({
	args: { token: v.string(), browserId: v.string() },
	returns: publicAuthor,
	handler: async (ctx, args) => {
		const context = await discussionContext(ctx, args);
		return authorView(ctx, context.root, await discussionActor(ctx, context, args.browserId));
	}
});
export const thread = query({
	args: { access: discussionAccess, threadId: v.id('discussionThreads') },
	returns: v.union(discussionThread, v.null()),
	handler: async (ctx, { access, threadId }) => {
		const context = await discussionContext(ctx, access),
			row = await liveDiscussionThread(context, threadId);
		return row ? threadProjector(ctx, context)(row) : null;
	}
});
function threadProjector(ctx: QueryCtx, context: DiscussionContext) {
	const project = messageProjector(ctx, context.root);
	return async (thread: Doc<'discussionThreads'>) => {
		const root = await ctx.db
			.query('discussionMessages')
			.withIndex('by_threadId_and_reply', (q) => q.eq('threadId', thread._id).eq('reply', false))
			.unique();
		if (!owns(context, thread) || !root || !owns(context, root))
			throw new Error('Discussion root is missing.');
		return {
			id: thread._id,
			contentIdentity: thread.contentIdentity,
			contentRevision: thread.contentRevision,
			anchor: thread.anchor,
			type: thread.type,
			root: await project(root)
		};
	};
}
async function requireThread(
	ctx: QueryCtx,
	access: Infer<typeof discussionAccess>,
	threadId: Doc<'discussionThreads'>['_id']
) {
	const context = await discussionContext(ctx, access),
		thread = await liveDiscussionThread(context, threadId);
	if (!thread) throw new ConvexError('This discussion is unavailable.');
	return { thread, context };
}
export const latestReplies = query({
	args: { access: discussionAccess, threadId: v.id('discussionThreads') },
	returns: v.array(discussionMessage),
	handler: async (ctx, { access, threadId }) => {
		const { context } = await requireThread(ctx, access, threadId);
		const rows = await ctx.db
			.query('discussionMessages')
			.withIndex('by_threadId_and_reply', (q) => q.eq('threadId', threadId).eq('reply', true))
			.order('desc')
			.take(20);
		return Promise.all(rows.reverse().map(messageProjector(ctx, context.root)));
	}
});
export const message = query({
	args: {
		access: discussionAccess,
		threadId: v.id('discussionThreads'),
		messageId: v.id('discussionMessages')
	},
	returns: v.union(discussionMessage, v.null()),
	handler: async (ctx, { access, threadId, messageId }) => {
		const { context } = await requireThread(ctx, access, threadId),
			row = await ctx.db.get('discussionMessages', messageId);
		return row && row.reply && row.threadId === threadId && owns(context, row)
			? messageProjector(ctx, context.root)(row)
			: null;
	}
});
