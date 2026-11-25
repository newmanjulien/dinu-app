import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { ConvexError, v, type Infer } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import {
	internalMutation,
	internalQuery,
	mutation,
	query,
	type QueryCtx
} from './_generated/server';
import {
	discussionAccess,
	discussionCommand,
	discussionMessage,
	discussionThread,
	markSeenResult,
	publicAuthor,
	seenMessages,
	writeResult
} from '../lib/discussions/validators';
import { requireMembership } from './auth';
import { markDiscussionSeen, writeDiscussion } from './discussionCommands';
import { discussionContext, ownsDiscussion, type DiscussionContext } from './discussionContext';
import { authorView, discussionActor, messageProjector } from './discussionService';

export { discussionContext } from './discussionContext';

const privateContextArgs = {
	membershipId: v.id('memberships'),
	id: v.id('savedContracts'),
	token: v.string()
};

async function privateContext(
	ctx: QueryCtx,
	args: Infer<typeof discussionAccess> & {
		membershipId: Doc<'memberships'>['_id'];
		id: Doc<'savedContracts'>['_id'];
	}
) {
	const access = await requireMembership(ctx, args.membershipId);
	const context = await discussionContext(ctx, args);
	if (context.root._id !== args.id || context.root.companyId !== access.companyId)
		throw new ConvexError('This contract is unavailable.');
	return { access, context };
}

function threadProjector(ctx: QueryCtx, context: DiscussionContext) {
	const project = messageProjector(ctx, context.root);
	return async (thread: Doc<'discussionThreads'>) => {
		const root = await ctx.db
			.query('discussionMessages')
			.withIndex('by_threadId_and_reply', (q) => q.eq('threadId', thread._id).eq('reply', false))
			.unique();
		if (!ownsDiscussion(context, thread) || !root || !ownsDiscussion(context, root)) return null;
		return {
			id: thread._id,
			contentRevision: thread.contentRevision,
			anchor: thread.anchor,
			root: await project(root)
		};
	};
}

/** Paginated reactive list of live comment threads for a buyer link. */
export const list = query({
	args: { access: discussionAccess, paginationOpts: paginationOptsValidator },
	returns: paginationResultValidator(discussionThread),
	handler: async (ctx, { access, paginationOpts }) => {
		const context = await discussionContext(ctx, access);
		const result = await ctx.db
			.query('discussionThreads')
			.withIndex('by_contractId', (q) => q.eq('contractId', context.root._id))
			.order('asc')
			.paginate(paginationOpts);
		const project = threadProjector(ctx, context);
		const projected = await Promise.all(result.page.map(project));
		return {
			...result,
			page: projected.filter((item): item is NonNullable<typeof item> => item !== null)
		};
	}
});

/** Paginated reactive replies for one open comment thread. */
export const replies = query({
	args: {
		access: discussionAccess,
		threadId: v.id('discussionThreads'),
		paginationOpts: paginationOptsValidator
	},
	returns: paginationResultValidator(discussionMessage),
	handler: async (ctx, { access, threadId, paginationOpts }) => {
		const context = await discussionContext(ctx, access);
		const thread = await ctx.db.get('discussionThreads', threadId);
		if (!thread || !ownsDiscussion(context, thread))
			return { page: [], isDone: true, continueCursor: '' };
		const result = await ctx.db
			.query('discussionMessages')
			.withIndex('by_threadId_and_reply', (q) => q.eq('threadId', threadId).eq('reply', true))
			.order('asc')
			.paginate(paginationOpts);
		const project = messageProjector(ctx, context.root);
		return {
			...result,
			page: await Promise.all(result.page.map(project))
		};
	}
});

export const viewer = query({
	args: privateContextArgs,
	returns: publicAuthor,
	handler: async (ctx, args) => {
		const { access, context } = await privateContext(ctx, args);
		return authorView(ctx, context.root, await discussionActor(ctx, context, undefined, access));
	}
});

export const markSeen = mutation({
	args: { ...privateContextArgs, operationId: v.string(), messages: seenMessages },
	returns: markSeenResult,
	handler: async (ctx, args) => {
		const { access, context } = await privateContext(ctx, args);
		return markDiscussionSeen(
			ctx,
			context,
			await discussionActor(ctx, context, undefined, access),
			{
				token: args.token,
				operationId: args.operationId,
				messages: args.messages
			}
		);
	}
});

export const write = mutation({
	args: { ...privateContextArgs, operationId: v.string(), command: discussionCommand },
	returns: writeResult,
	handler: async (ctx, args) => {
		const { access, context } = await privateContext(ctx, args);
		return writeDiscussion(ctx, context, await discussionActor(ctx, context, undefined, access), {
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
	const context = await discussionContext(ctx, args);
	const actor = await discussionActor(ctx, context, args.browserId);
	if (actor.key !== args.expectedAuthorKey)
		throw new ConvexError({
			code: 'DISCUSSION_IDENTITY_CHANGED',
			message: 'Reconnect as the original author before retrying.'
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

export const buyerViewer = internalQuery({
	args: { token: v.string(), browserId: v.string() },
	returns: publicAuthor,
	handler: async (ctx, args) => {
		const context = await discussionContext(ctx, args);
		return authorView(ctx, context.root, await discussionActor(ctx, context, args.browserId));
	}
});
