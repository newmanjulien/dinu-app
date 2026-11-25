import { ConvexError, type Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { anchorPassage, extractFootprint, validDiscussionAnchor } from '../lib/discussions/anchors';
import { validDiscussionText } from '../lib/discussions/limits';
import {
	discussionCommand,
	markSeenResult,
	seenMessages,
	writeResult
} from '../lib/discussions/validators';
import { DocumentCompositionEngine } from '../lib/document/compose';
import { toDocumentOverlay } from '../lib/playbook/document-overlay';
import { isRepItem } from '../lib/playbook/model';
import { prepareDiscussionQuota } from './buyerActivityQuota';
import { ownsDiscussion, type DiscussionContext } from './discussionContext';
import { deleteThreadAndMessages, refreshDirectoryUnread } from './discussionInvalidation';
import type { DiscussionActor } from './discussionService';
import { actionKey, receipt, remember, scopedKey, validateOperationId } from './operationReceipts';
import { versionReader } from './templates';

export type WriteInput = {
	token: string;
	operationId: string;
	command: Infer<typeof discussionCommand>;
};
export type SeenInput = {
	token: string;
	operationId: string;
	messages: Infer<typeof seenMessages>;
};

function discussionOperationKey(
	actor: DiscussionActor,
	kind: 'discussion-write' | 'discussion-mark-seen',
	operationId: string
) {
	return actor.access
		? actionKey(actor.access, kind, operationId)
		: scopedKey(actor.key, kind, operationId);
}

/** Synchronous comment create/reply/edit/delete using targeted template reads and hard-delete. */
export async function writeDiscussion(
	ctx: MutationCtx,
	context: DiscussionContext,
	actor: DiscussionActor,
	input: WriteInput
): Promise<Infer<typeof writeResult>> {
	validateOperationId(input.operationId);
	const key = discussionOperationKey(actor, 'discussion-write', input.operationId);
	const inputs = JSON.stringify([context.root._id, input.command]);
	const prior = await receipt(ctx, key, inputs);
	if (prior) {
		if (prior.companyId !== context.root.companyId || prior.contractId !== context.root._id)
			throw new ConvexError('This operation is unavailable.');
		return JSON.parse(prior.result) as Infer<typeof writeResult>;
	}

	const { root, view } = context;
	const { command } = input;
	const owner = { companyId: root.companyId, contractId: root._id };
	const quota = await prepareDiscussionQuota(ctx, owner, actor.key);

	if (command.kind === 'create') {
		if (command.contentRevision !== view.contentRevision)
			throw new ConvexError(
				'This passage changed. Select the current wording to comment. Your draft is still here.'
			);
		if (!validDiscussionAnchor(command.anchor)) throw new ConvexError('Select a shorter passage.');
		if (!validDiscussionText(command.text))
			throw new ConvexError('Enter a message of 20,000 characters or fewer.');

		const reader = await versionReader(ctx, view.templateVersionId, root.companyId, true);
		const appliedIds = Object.keys(view.concessions) as Id<'playbookItems'>[];
		const [blocks, appliedItems] = await Promise.all([
			reader.blocks(),
			reader.readItemsByIds(appliedIds)
		]);
		const overlays = appliedItems.filter(isRepItem).map((item) => toDocumentOverlay(item));
		const engine = new DocumentCompositionEngine(blocks);
		const resolved = [
			...engine.compose({
				items: overlays,
				activeConcessions: view.concessions,
				view: 'effective'
			})
		];
		const parts = anchorPassage(resolved, command.anchor, true);
		if (!parts)
			throw new ConvexError('This passage changed. Select the current wording to comment.');
		const footprint = extractFootprint(engine.index, parts, engine.generatedAnchors);

		await quota.commit();
		const unreadByTeam = !actor.profileId;
		const threadId = await ctx.db.insert('discussionThreads', {
			...owner,
			contentRevision: view.contentRevision,
			anchor: command.anchor,
			footprint,
			unreadMessageCount: unreadByTeam ? 1 : 0,
			hasUnread: unreadByTeam
		});
		const messageId = await ctx.db.insert('discussionMessages', {
			...owner,
			threadId,
			reply: false,
			authorKey: actor.key,
			operationId: input.operationId,
			profileId: actor.profileId,
			text: command.text,
			revision: 1,
			unreadByTeam
		});
		if (unreadByTeam) await refreshDirectoryUnread(ctx, root._id);

		const result = {
			status: 'complete' as const,
			operationId: input.operationId,
			threadId,
			messageId
		};
		await remember(ctx, root.companyId, key, inputs, JSON.stringify(result), root._id);
		return result;
	}

	if (command.kind === 'reply') {
		if (!validDiscussionText(command.text))
			throw new ConvexError('Enter a message of 20,000 characters or fewer.');
		const thread = await ctx.db.get('discussionThreads', command.threadId);
		if (!thread || !ownsDiscussion(context, thread))
			throw new ConvexError('This discussion is unavailable.');

		await quota.commit();
		const unreadByTeam = !actor.profileId;
		const messageId = await ctx.db.insert('discussionMessages', {
			...owner,
			threadId: thread._id,
			reply: true,
			authorKey: actor.key,
			operationId: input.operationId,
			profileId: actor.profileId,
			text: command.text,
			revision: 1,
			unreadByTeam
		});
		if (unreadByTeam) {
			const nextUnread = thread.unreadMessageCount + 1;
			await ctx.db.patch('discussionThreads', thread._id, {
				unreadMessageCount: nextUnread,
				hasUnread: true
			});
			await refreshDirectoryUnread(ctx, root._id);
		}
		const result = {
			status: 'complete' as const,
			operationId: input.operationId,
			threadId: thread._id,
			messageId
		};
		await remember(ctx, root.companyId, key, inputs, JSON.stringify(result), root._id);
		return result;
	}

	const message = await ctx.db.get('discussionMessages', command.messageId);
	if (!message || !ownsDiscussion(context, message) || message.authorKey !== actor.key)
		throw new ConvexError('Only the author can change this message.');
	if (message.revision !== command.expectedRevision)
		throw new ConvexError('This message changed. Refresh before editing it.');
	const thread = await ctx.db.get('discussionThreads', message.threadId);
	if (!thread || !ownsDiscussion(context, thread))
		throw new ConvexError('This discussion is unavailable.');

	if (command.kind === 'edit') {
		if (!validDiscussionText(command.text))
			throw new ConvexError('Enter a message of 20,000 characters or fewer.');
		await quota.commit();
		const unreadByTeam = !actor.profileId;
		await ctx.db.patch('discussionMessages', message._id, {
			text: command.text,
			revision: message.revision + 1,
			unreadByTeam
		});
		const delta = Number(unreadByTeam) - Number(message.unreadByTeam);
		if (delta !== 0) {
			const nextUnread = Math.max(0, thread.unreadMessageCount + delta);
			await ctx.db.patch('discussionThreads', thread._id, {
				unreadMessageCount: nextUnread,
				hasUnread: nextUnread > 0
			});
			await refreshDirectoryUnread(ctx, root._id);
		}
		const result = {
			status: 'complete' as const,
			operationId: input.operationId,
			threadId: thread._id,
			messageId: message._id
		};
		await remember(ctx, root.companyId, key, inputs, JSON.stringify(result), root._id);
		return result;
	}

	if (command.target !== (message.reply ? 'reply' : 'thread'))
		throw new ConvexError('This discussion changed. Refresh before deleting it.');
	await quota.commit();
	if (!message.reply) {
		await deleteThreadAndMessages(ctx, thread._id);
		await refreshDirectoryUnread(ctx, root._id);
	} else {
		await ctx.db.delete('discussionMessages', message._id);
		if (message.unreadByTeam) {
			const nextUnread = Math.max(0, thread.unreadMessageCount - 1);
			await ctx.db.patch('discussionThreads', thread._id, {
				unreadMessageCount: nextUnread,
				hasUnread: nextUnread > 0
			});
			await refreshDirectoryUnread(ctx, root._id);
		}
	}
	const result = {
		status: 'complete' as const,
		operationId: input.operationId,
		threadId: thread._id,
		messageId: message._id
	};
	await remember(ctx, root.companyId, key, inputs, JSON.stringify(result), root._id);
	return result;
}

export async function markDiscussionSeen(
	ctx: MutationCtx,
	context: DiscussionContext,
	actor: DiscussionActor,
	input: SeenInput
): Promise<Infer<typeof markSeenResult>> {
	validateOperationId(input.operationId);
	if (!actor.profileId) throw new ConvexError('Only the company team can acknowledge messages.');
	if (
		input.messages.length > 20 ||
		input.messages.some((m) => !Number.isSafeInteger(m.revision) || m.revision < 1) ||
		new Set(input.messages.map((m) => m.messageId)).size !== input.messages.length
	)
		throw new ConvexError('Use a bounded list of distinct message revisions.');

	const key = discussionOperationKey(actor, 'discussion-mark-seen', input.operationId);
	const inputs = JSON.stringify([context.root._id, input.messages]);
	const prior = await receipt(ctx, key, inputs);
	if (prior) {
		if (prior.companyId !== context.root.companyId || prior.contractId !== context.root._id)
			throw new ConvexError('This operation is unavailable.');
		return JSON.parse(prior.result) as Infer<typeof markSeenResult>;
	}

	const affected = new Map<
		Id<'discussionThreads'>,
		{ thread: Doc<'discussionThreads'>; count: number }
	>();
	for (const seen of input.messages) {
		const message = await ctx.db.get('discussionMessages', seen.messageId);
		if (!message) continue;
		if (!ownsDiscussion(context, message)) throw new ConvexError('This message is unavailable.');
		const thread = await ctx.db.get('discussionThreads', message.threadId);
		if (!thread || !ownsDiscussion(context, thread)) continue;
		if (message.profileId || !message.unreadByTeam || message.revision !== seen.revision) continue;
		await ctx.db.patch('discussionMessages', message._id, { unreadByTeam: false });
		const entry = affected.get(thread._id) ?? { thread, count: thread.unreadMessageCount };
		entry.count = Math.max(0, entry.count - 1);
		affected.set(thread._id, entry);
	}
	for (const { thread, count } of affected.values()) {
		await ctx.db.patch('discussionThreads', thread._id, {
			unreadMessageCount: count,
			hasUnread: count > 0
		});
	}
	if (affected.size > 0) await refreshDirectoryUnread(ctx, context.root._id);

	const result = { status: 'complete' as const, operationId: input.operationId };
	await remember(
		ctx,
		context.root.companyId,
		key,
		inputs,
		JSON.stringify(result),
		context.root._id
	);
	return result;
}
