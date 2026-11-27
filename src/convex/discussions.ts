import { ConvexError, v } from 'convex/values';
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
	discussionList,
	markSeenResult,
	publicAuthor,
	seenMessages,
	writeResult
} from '../lib/discussions/validators';
import { markDiscussionSeen, writeDiscussion } from './discussionCommands';
import { DISCUSSION_THREAD_LIMIT, DISCUSSION_MESSAGE_LIMIT } from '../lib/discussions/limits';
import {
	buyerDiscussionContext,
	ownsDiscussion,
	sellerDiscussionContext
} from './discussionContext';
import {
	authorView,
	buyerDiscussionActor,
	messageProjector,
	sellerDiscussionActor
} from './discussionService';

export { discussionContext } from './discussionContext';

const sellerContextArgs = {
	membershipId: v.id('memberships'),
	id: v.id('savedContracts')
};

/** One bounded live snapshot, including replies and the authenticated seller author. */
export const list = query({
	args: { access: discussionAccess },
	returns: discussionList,
	handler: async (ctx, { access }) => {
		const resolved =
			access.kind === 'seller'
				? await sellerDiscussionContext(ctx, undefined, access.id)
				: { context: await buyerDiscussionContext(ctx, access.token), access: null };
		const { context } = resolved;
		const [threads, messages] = await Promise.all([
			ctx.db
				.query('discussionThreads')
				.withIndex('by_contractId', (q) => q.eq('contractId', context.root._id))
				.order('desc')
				.take(DISCUSSION_THREAD_LIMIT),
			ctx.db
				.query('discussionMessages')
				.withIndex('by_contractId', (q) => q.eq('contractId', context.root._id))
				.order('desc')
				.take(DISCUSSION_MESSAGE_LIMIT)
		]);
		const project = messageProjector(ctx, context.root);
		// Seed the shared author cache before projecting messages by that same seller.
		const viewer = resolved.access
			? await project.author(sellerDiscussionActor(context.root, resolved.access))
			: null;
		const grouped = new Map<
			string,
			{ root?: (typeof messages)[number]; replies: typeof messages }
		>();
		for (const message of messages.reverse()) {
			if (!ownsDiscussion(context, message)) continue;
			const group = grouped.get(message.threadId) ?? { replies: [] };
			if (message.reply) group.replies.push(message);
			else group.root = message;
			grouped.set(message.threadId, group);
		}
		const projected = await Promise.all(
			threads.reverse().map(async (thread) => {
				const group = grouped.get(thread._id);
				if (!ownsDiscussion(context, thread) || !group?.root) return null;
				const [root, replies] = await Promise.all([
					project.message(group.root),
					Promise.all(group.replies.map(project.message))
				]);
				return {
					id: thread._id,
					contentRevision: thread.contentRevision,
					anchor: thread.anchor,
					root,
					replies
				};
			})
		);
		return {
			viewer,
			threads: projected.filter((thread): thread is NonNullable<typeof thread> => thread !== null)
		};
	}
});

export const markSeen = mutation({
	args: { ...sellerContextArgs, operationId: v.string(), messages: seenMessages },
	returns: markSeenResult,
	handler: async (ctx, args) => {
		const { access, context } = await sellerDiscussionContext(ctx, args.membershipId, args.id);
		return markDiscussionSeen(ctx, context, sellerDiscussionActor(context.root, access), {
			operationId: args.operationId,
			messages: args.messages
		});
	}
});

export const write = mutation({
	args: { ...sellerContextArgs, operationId: v.string(), command: discussionCommand },
	returns: writeResult,
	handler: async (ctx, args) => {
		const { access, context } = await sellerDiscussionContext(ctx, args.membershipId, args.id);
		return writeDiscussion(ctx, context, sellerDiscussionActor(context.root, access), {
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
	args: { token: string; browserId: string; expectedAuthorKey: string }
) {
	const context = await buyerDiscussionContext(ctx, args.token);
	const actor = await buyerDiscussionActor(ctx, context.root, args.browserId);
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
			operationId: args.operationId,
			command: args.command
		});
	}
});

export const buyerViewer = internalQuery({
	args: { token: v.string(), browserId: v.string() },
	returns: publicAuthor,
	handler: async (ctx, args) => {
		const context = await buyerDiscussionContext(ctx, args.token);
		return authorView(
			ctx,
			context.root,
			await buyerDiscussionActor(ctx, context.root, args.browserId)
		);
	}
});
