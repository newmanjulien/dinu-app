import { releasedRecord } from '../lib/contract/released-selections';
import { ConvexError, v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { query, mutation, internalMutation, internalQuery } from './_generated/server';
import { resolve, resolveAccess, contractAccess, seller } from './buyerLinks';
import {
	discussionCommand,
	discussionThread,
	discussionMessage,
	publicAuthor,
	writeResult
} from '../lib/discussions/validators';
import {
	discussionActor,
	authorView,
	messageProjector,
	writeDiscussion
} from './discussionService';
import type { QueryCtx } from './_generated/server';
import type { Infer } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { requireMembership } from './auth';
const accessArgs = v.union(
	v.object({ token: v.string() }),
	v.object({ membershipId: v.id('memberships'), id: v.id('savedContracts') })
);
async function contractFor(ctx: QueryCtx, access: Infer<typeof accessArgs>) {
	if ('token' in access) {
		const found = await resolveAccess(ctx, access.token);
		if (!found) throw new ConvexError('This link is unavailable.');
		return found.contract;
	}
	const member = await requireMembership(ctx, access.membershipId);
	const contract = await contractAccess(ctx, access.id);
	if (!contract || contract.companyId !== member.companyId)
		throw new ConvexError('This contract is unavailable.');
	return contract;
}
function boundPage(opts: {
	numItems: number;
	maximumRowsRead?: number;
	maximumBytesRead?: number;
}) {
	if (
		opts.numItems > 40 ||
		(opts.maximumRowsRead ?? Infinity) > 50 ||
		(opts.maximumBytesRead ?? Infinity) > 1_500_000
	)
		throw new ConvexError('Use bounded discussion pages.');
}
export const threads = query({
	args: { access: accessArgs, paginationOpts: paginationOptsValidator },
	returns: paginationResultValidator(discussionThread),
	handler: async (ctx, { access, paginationOpts }) => {
		boundPage(paginationOpts);
		const contract = await contractFor(ctx, access);
		const page = await ctx.db
			.query('discussionThreads')
			.withIndex('by_contractId', (q) => q.eq('contractId', contract._id))
			.order('asc')
			.paginate(paginationOpts);
		const project = threadProjector(ctx, contract);
		return { ...page, page: await Promise.all(page.page.map(project)) };
	}
});
export const replies = query({
	args: {
		access: accessArgs,
		threadId: v.id('discussionThreads'),
		paginationOpts: paginationOptsValidator
	},
	returns: paginationResultValidator(discussionMessage),
	handler: async (ctx, { access, threadId, paginationOpts }) => {
		boundPage(paginationOpts);
		const contract = await contractFor(ctx, access);
		const thread = await ctx.db.get('discussionThreads', threadId);
		if (!thread || thread.contractId !== contract._id || thread.companyId !== contract.companyId)
			throw new ConvexError('This discussion is unavailable.');
		const page = await ctx.db
			.query('discussionMessages')
			.withIndex('by_threadId_and_reply', (q) => q.eq('threadId', threadId).eq('reply', true))
			.paginate(paginationOpts);
		const project = messageProjector(ctx);
		return { ...page, page: await Promise.all(page.page.map(project)) };
	}
});
export const viewer = query({
	args: { membershipId: v.id('memberships'), id: v.id('savedContracts') },
	returns: publicAuthor,
	handler: async (ctx, args) => {
		const contract = await contractFor(ctx, args);
		return authorView(ctx, contract.companyId, await discussionActor(ctx, contract));
	}
});
export const write = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('savedContracts'),
		operationId: v.string(),
		command: discussionCommand
	},
	returns: writeResult,
	handler: async (ctx, args) => {
		const { contract } = await seller(ctx, args);
		return writeDiscussion(
			ctx,
			contract,
			await discussionActor(ctx, contract),
			args.operationId,
			args.command,
			contract.editRevision
		);
	}
});
/** Only the secret-authenticated HTTP ingress can supply the private browser credential. */
export const buyerWrite = internalMutation({
	args: {
		token: v.string(),
		browserId: v.string(),
		operationId: v.string(),
		expectedAuthorKey: v.string(),
		command: discussionCommand
	},
	returns: writeResult,
	handler: async (ctx, args) => {
		const result = await resolve(ctx, args.token);
		if (!result) throw new ConvexError('This link is unavailable.');
		const contract = await ctx.db.get('savedContracts', result.contract._id);
		if (!contract || contract.companyId !== result.contract.companyId)
			throw new ConvexError('This link is unavailable.');
		const actor = await discussionActor(ctx, contract, args.browserId);
		if (actor.key !== args.expectedAuthorKey)
			throw new ConvexError({
				code: 'DISCUSSION_IDENTITY_CHANGED',
				message: 'Reconnect as the original author before retrying. Your draft is still here.'
			});
		return writeDiscussion(
			ctx,
			contract,
			actor,
			args.operationId,
			args.command,
			result.state.buyerRevision,
			releasedRecord(result.state.selections)
		);
	}
});
export const buyerViewer = internalQuery({
	args: { token: v.string(), browserId: v.string() },
	returns: publicAuthor,
	handler: async (ctx, args) => {
		const result = await resolveAccess(ctx, args.token);
		if (!result) throw new ConvexError('This link is unavailable.');
		return authorView(
			ctx,
			result.contract.companyId,
			await discussionActor(ctx, result.contract, args.browserId)
		);
	}
});

/** The just-created thread remains visible without reading every older page. */
export const thread = query({
	args: { access: accessArgs, threadId: v.id('discussionThreads') },
	returns: v.union(discussionThread, v.null()),
	handler: async (ctx, { access, threadId }) => {
		const contract = await contractFor(ctx, access);
		const thread = await ctx.db.get('discussionThreads', threadId);
		if (!thread || thread.contractId !== contract._id || thread.companyId !== contract.companyId)
			return null;
		return threadProjector(ctx, contract)(thread);
	}
});

function threadProjector(
	ctx: QueryCtx,
	contract: { _id: Doc<'savedContracts'>['_id']; companyId: Doc<'company'>['_id'] }
) {
	const project = messageProjector(ctx);
	return async (thread: Doc<'discussionThreads'>) => {
		const root = await ctx.db
			.query('discussionMessages')
			.withIndex('by_threadId_and_reply', (q) => q.eq('threadId', thread._id).eq('reply', false))
			.unique();
		if (
			thread.companyId !== contract.companyId ||
			!root ||
			root.contractId !== contract._id ||
			root.companyId !== contract.companyId
		)
			throw new Error('Discussion root is missing.');
		return {
			id: thread._id,
			anchor: thread.anchor,
			type: thread.type,
			applied: thread.applied,
			root: await project(root)
		};
	};
}
async function requireThread(
	ctx: QueryCtx,
	access: Infer<typeof accessArgs>,
	threadId: Doc<'discussionThreads'>['_id']
) {
	const contract = await contractFor(ctx, access);
	const thread = await ctx.db.get('discussionThreads', threadId);
	if (!thread || thread.contractId !== contract._id || thread.companyId !== contract.companyId)
		throw new ConvexError('This discussion is unavailable.');
	return thread;
}
export const latestReplies = query({
	args: { access: accessArgs, threadId: v.id('discussionThreads') },
	returns: v.array(discussionMessage),
	handler: async (ctx, { access, threadId }) => {
		await requireThread(ctx, access, threadId);
		const rows = await ctx.db
			.query('discussionMessages')
			.withIndex('by_threadId_and_reply', (q) => q.eq('threadId', threadId).eq('reply', true))
			.order('desc')
			.take(20);
		return Promise.all(rows.reverse().map(messageProjector(ctx)));
	}
});
export const message = query({
	args: {
		access: accessArgs,
		threadId: v.id('discussionThreads'),
		messageId: v.id('discussionMessages')
	},
	returns: v.union(discussionMessage, v.null()),
	handler: async (ctx, { access, threadId, messageId }) => {
		const thread = await requireThread(ctx, access, threadId);
		const row = await ctx.db.get('discussionMessages', messageId);
		return row &&
			row.reply &&
			row.threadId === threadId &&
			row.contractId === thread.contractId &&
			row.companyId === thread.companyId
			? messageProjector(ctx)(row)
			: null;
	}
});
