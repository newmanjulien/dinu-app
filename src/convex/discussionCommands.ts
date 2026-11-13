import { ConvexError, type Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import {
	discussionCommand,
	writeResult,
	seenMessages,
	markSeenResult
} from '../lib/discussions/validators';
import { validDiscussionText } from '../lib/discussions/limits';
import { canonicalJson } from '../lib/document/canonical-json';
import { validDiscussionAnchor } from '../lib/discussions/anchors';
import { discussionTape, passageInterval } from '../lib/discussions/tape';
import {
	ownsDiscussion,
	liveDiscussionThread,
	readDiscussionWording,
	type DiscussionContext
} from './discussionContext';
import { fingerprint, type DiscussionActor } from './discussionService';
import { DiscussionIndex } from './discussionIndex';
import { prepareProposalClaim, admitProposalClaim } from './discussionClaims';
import { changeSession, admitTransition, type TransitionWork } from './contractChanges';
import { withdrawProposalRoot } from './contractAuthority';
import { discussionTransitionHooks } from './discussionTransitions';
import { DiscussionPreparationRequired, admitDiscussionWork } from './discussionMaps';
import {
	deferDiscussionOperation,
	preparedDiscussionProof,
	type DiscussionPreparationPlan
} from './discussionPreparation';
import { operation, receipt, sealReceipt, receiptSealWork, actionKey } from './operationReceipts';
import { prepareDiscussionQuota } from './buyerActivityQuota';
import { documentBytes } from './storageCapacity';

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
type Kind = 'discussion-write' | 'discussion-mark-seen';
export function discussionOperationKey(actor: DiscussionActor, kind: Kind, operationId: string) {
	operation(operationId);
	return actor.access
		? actionKey(actor.access, kind, operationId)
		: JSON.stringify([actor.key, kind, operationId]);
}
export async function discussionReplay(
	ctx: QueryCtx,
	context: DiscussionContext,
	actor: DiscussionActor,
	operationId: string,
	command: Infer<typeof discussionCommand>
) {
	operation(operationId);
	const replay = await ctx.db
		.query('discussionReceipts')
		.withIndex('by_contractId_and_actorKey_and_operationId', (q) =>
			q.eq('contractId', context.root._id).eq('actorKey', actor.key).eq('operationId', operationId)
		)
		.unique();
	if (!replay) return null;
	if (
		!ownsDiscussion(context, replay) ||
		replay.fingerprint !== fingerprint(JSON.stringify(command))
	)
		throw new ConvexError('This message operation was already used.');
	const thread = await liveDiscussionThread(context, replay.threadId);
	if (!thread) throw new ConvexError('This discussion is unavailable.');
	return {
		status: 'complete' as const,
		operationId,
		threadId: replay.threadId,
		messageId: replay.messageId
	};
}
function commandPlan(
	context: DiscussionContext,
	input: WriteInput | SeenInput,
	affected: unknown,
	excluding: Doc<'discussionThreads'>[]
): DiscussionPreparationPlan {
	const identity = fingerprint(JSON.stringify([input, affected]));
	return {
		index: context.index,
		sourceDocumentId: context.root.documentId,
		nativeStateRevision: context.root.stateRevision,
		planIdentity: identity,
		proofIdentity: identity,
		excluding
	};
}
async function proofWitness(
	context: DiscussionContext,
	plan: DiscussionPreparationPlan,
	resuming?: Doc<'operationReceipts'>
) {
	if (resuming) {
		const proof = preparedDiscussionProof(resuming, plan);
		if (!proof) throw new DiscussionPreparationRequired('unread-proof');
		return proof.witnessThreadId;
	}
	return context.index.witness(undefined, plan.excluding);
}
async function sealWork(
	ctx: QueryCtx,
	resuming: Doc<'operationReceipts'> | undefined,
	inputs: string,
	result: string
): Promise<TransitionWork> {
	if (!resuming) return {};
	const work = await receiptSealWork(ctx, resuming, inputs, result);
	return {
		documents: work.writes,
		bytes: work.bytes,
		queries: work.reads,
		readDocuments: work.reads,
		readBytes: work.readBytes
	};
}
function plus(...works: TransitionWork[]): TransitionWork {
	const result: TransitionWork = {};
	for (const work of works)
		for (const key of Object.keys(work) as (keyof TransitionWork)[])
			result[key] = (result[key] ?? 0) + (work[key] ?? 0);
	return result;
}
async function defer(
	ctx: MutationCtx,
	context: DiscussionContext,
	actor: DiscussionActor,
	kind: Kind,
	input: WriteInput | SeenInput,
	plan: DiscussionPreparationPlan,
	prior?: Doc<'operationReceipts'>
) {
	return deferDiscussionOperation(ctx, {
		contract: context.contract,
		actor: actor.preparation,
		kind,
		operationId: input.operationId,
		key: discussionOperationKey(actor, kind, input.operationId),
		inputs: JSON.stringify(input),
		prior,
		plan: { ...plan, index: await DiscussionIndex.open(ctx, context.root) }
	});
}
async function priorOperation(
	ctx: QueryCtx,
	context: DiscussionContext,
	actor: DiscussionActor,
	kind: Kind,
	input: WriteInput | SeenInput,
	resuming?: Doc<'operationReceipts'>,
	allowFailed = false
) {
	const prior = await receipt(
		ctx,
		discussionOperationKey(actor, kind, input.operationId),
		JSON.stringify(input)
	);
	if (
		prior &&
		(prior.contractId !== context.root._id ||
			prior.companyId !== context.root.companyId ||
			prior.kind !== kind ||
			canonicalJson(prior.actor) !== canonicalJson(actor.preparation))
	)
		throw new ConvexError('This operation is unavailable.');
	if (resuming && prior?._id !== resuming._id)
		throw new Error('Only the original discussion operation can resume.');
	if (prior?.state === 'failed' && !allowFailed)
		throw new ConvexError(prior.error ?? 'This operation could not complete.');
	return prior;
}

async function requireWriteTarget(ctx: QueryCtx, context: DiscussionContext, input: WriteInput) {
	if (input.command.kind === 'create') return;
	const message =
		input.command.kind === 'reply'
			? null
			: await ctx.db.get('discussionMessages', input.command.messageId);
	const threadId = input.command.kind === 'reply' ? input.command.threadId : message?.threadId;
	if (
		(message && !ownsDiscussion(context, message)) ||
		!threadId ||
		!(await liveDiscussionThread(context, threadId))
	)
		throw new ConvexError('This discussion is unavailable.');
}
async function requireSeenTargets(ctx: QueryCtx, context: DiscussionContext, input: SeenInput) {
	for (const seen of input.messages) {
		const message = await ctx.db.get('discussionMessages', seen.messageId);
		if (
			!message ||
			!ownsDiscussion(context, message) ||
			!(await liveDiscussionThread(context, message.threadId))
		)
			throw new ConvexError('This discussion is unavailable.');
	}
}
/** Normal writes use only the existing message receipt. Exceptional commands retain
 * the original actor/input and seal its shared receipt with the business commit. */
export async function writeDiscussion(
	ctx: MutationCtx,
	context: DiscussionContext,
	actor: DiscussionActor,
	input: WriteInput,
	resuming?: Doc<'operationReceipts'>
): Promise<Infer<typeof writeResult>> {
	context.index = await DiscussionIndex.open(ctx, context.root, () =>
		admitDiscussionWork(ctx, { reads: 1, queries: 1 })
	);
	const prior = await priorOperation(ctx, context, actor, 'discussion-write', input, resuming);
	const replay = await discussionReplay(ctx, context, actor, input.operationId, input.command);
	if (replay) return replay;
	if (prior?.state === 'complete') throw new ConvexError('This discussion is unavailable.');
	if (prior?.state === 'preparing' && !resuming) {
		await requireWriteTarget(ctx, context, input);
		return { status: 'preparing', operationId: input.operationId };
	}
	const { command } = input,
		{ root, index } = context;
	const owner = { companyId: root.companyId, contractId: root._id };
	let plan = commandPlan(context, input, null, []),
		started = false;
	try {
		await admitDiscussionWork(ctx, { reads: 8, queries: 8 });
		let thread: Doc<'discussionThreads'>,
			message: Doc<'discussionMessages'> | null = null;
		let tapeLength: number;
		const creating = command.kind === 'create';
		if (creating) {
			if (command.revision !== root.documentRevision || command.contentIdentity !== root.documentId)
				throw new ConvexError(
					'This passage changed. Select the current wording to comment. Your draft is still here.'
				);
			if (!validDiscussionAnchor(command.anchor))
				throw new ConvexError('Select a shorter passage.');
			const prepared = resuming?.preparation?.sourcePassage;
			let interval: { start: number; end: number } | null;
			if (
				prepared &&
				prepared.inputHash === fingerprint(JSON.stringify(input)) &&
				prepared.documentId === root.documentId &&
				prepared.documentRevision === root.documentRevision
			) {
				interval = { start: prepared.start, end: prepared.end };
				tapeLength = prepared.tapeLength;
			} else {
				const tape = discussionTape((await readDiscussionWording(ctx, context)).document);
				interval = passageInterval(tape, command.anchor);
				tapeLength = tape.length;
			}
			if (!interval) throw new ConvexError('This passage changed. Select the current wording.');
			if (command.type === 'proposal') await admitProposalClaim(ctx, index, interval, tapeLength);
			thread = {
				...owner,
				_id: root._id as unknown as Id<'discussionThreads'>,
				_creationTime: 0,
				anchor: command.anchor,
				unreadKey: fingerprint(JSON.stringify([actor.key, input.operationId])),
				contentIdentity: command.contentIdentity,
				contentRevision: command.revision,
				indexedDocumentRevision: root.documentRevision,
				indexedTapeLength: tapeLength,
				passageStart: interval.start,
				passageEnd: interval.end,
				unreadMessageCount: 0,
				tombstoned: false,
				type: command.type
			};
		} else {
			if (command.kind !== 'reply') {
				message = await ctx.db.get('discussionMessages', command.messageId);
				if (!message || !ownsDiscussion(context, message) || message.authorKey !== actor.key)
					throw new ConvexError('Only the author can change this message.');
				if (message.deleted || message.revision !== command.expectedRevision)
					throw new ConvexError('This message changed. Refresh before editing it.');
			}
			const found = await liveDiscussionThread(
				context,
				command.kind === 'reply' ? command.threadId : message!.threadId
			);
			if (!found) throw new ConvexError('This discussion is unavailable.');
			thread = found;
			// The cohort's tape length is already bounded metadata; no document read is
			// necessary for replies, edits, deletes or acknowledgments.
			tapeLength = thread.indexedTapeLength;
		}
		const proposalRoot = thread.type === 'proposal' && (creating || (message && !message.reply));
		if (command.kind !== 'delete' && !validDiscussionText(command.text, Boolean(proposalRoot)))
			throw new ConvexError('Enter a message of 20,000 characters or fewer.');
		const deletingRoot = command.kind === 'delete' && message && !message.reply;
		const nextUnread =
			thread.unreadMessageCount -
			Number(message?.unreadByTeam ?? false) +
			Number(command.kind !== 'delete' && !actor.profileId);
		const excluded = !creating && nextUnread === 0 ? [thread] : [];
		plan = commandPlan(
			context,
			input,
			[
				thread._id,
				thread.indexedDocumentRevision,
				thread.passageStart,
				thread.passageEnd,
				thread.unreadMessageCount,
				message?._id ?? null,
				message?.revision ?? null,
				message?.unreadByTeam ?? null,
				nextUnread
			],
			excluded
		);
		let witness = nextUnread > 0 ? thread._id : await proofWitness(context, plan, resuming);
		const claim =
			!creating && proposalRoot
				? await prepareProposalClaim(
						ctx,
						index,
						thread,
						deletingRoot ? null : await index.interval(thread),
						tapeLength
					)
				: undefined;
		const quota = await prepareDiscussionQuota(ctx, owner, actor.key);
		await index.prepareUnreadCount(thread, nextUnread, tapeLength);
		// Root withdrawal is prepared against the OLD exact root; message replacement
		// happens only after this native session commits in the same transaction.
		const session =
			!creating && proposalRoot
				? await changeSession(ctx, context.contract, { sourceOnly: { tapeLength } })
				: null;
		const withdrew =
			session && message
				? await withdrawProposalRoot(
						ctx,
						context.contract,
						session,
						thread._id,
						message._id,
						message.revision
					)
				: false;
		const result = {
			status: 'complete' as const,
			operationId: input.operationId,
			threadId: thread._id,
			messageId: message?._id ?? (root._id as unknown as Id<'discussionMessages'>)
		};
		const inputs = JSON.stringify(input);
		const receiptRow = {
			...owner,
			actorKey: actor.key,
			operationId: input.operationId,
			fingerprint: fingerprint(JSON.stringify(command)),
			threadId: thread._id,
			messageId: result.messageId
		};
		const threadFields = { unreadMessageCount: nextUnread };
		const messageRow = {
			...owner,
			threadId: thread._id,
			reply: command.kind === 'reply',
			authorKey: actor.key,
			profileId: actor.profileId,
			text: command.kind === 'delete' ? '' : command.text,
			revision: (message?.revision ?? 0) + 1,
			deleted: command.kind === 'delete',
			unreadByTeam: command.kind !== 'delete' && !actor.profileId
		};
		const tailWork = plus(
			quota.work,
			claim?.work ?? {},
			await sealWork(ctx, resuming, inputs, JSON.stringify(result)),
			{
				documents: 3 + Number(creating && proposalRoot),
				bytes:
					documentBytes(receiptRow) +
					documentBytes(messageRow) +
					documentBytes({ ...thread, ...threadFields }) +
					8192,
				queries: 8,
				readDocuments: 8,
				readBytes: 32_000,
				functionsScheduled: 0,
				scheduledFunctionArgsBytes: 0
			}
		);
		const discussions = discussionTransitionHooks(ctx, context.contract, {
			index,
			deferFlush: true,
			hooks: { beforeCommit: async () => ({ hasUnreadComment: Boolean(witness) }) }
		});
		if (withdrew && session) {
			await session.commit({
				sourceWithdrawal: {
					companyId: root.companyId,
					authorKey: actor.key,
					threadId: thread._id,
					rootMessageId: message!._id,
					rootRevision: message!.revision
				},
				operationId: input.operationId,
				hooks: discussions.hooks,
				reserveTail: async () => tailWork
			});
			started = true;
		} else {
			await admitTransition(
				ctx,
				plus(tailWork, await index.prepareFlush(witness), {
					documents: 1,
					bytes: 2048
				})
			);
			started = true;
		}
		await quota.commit();
		if (creating) {
			const { _id: temporaryId, _creationTime: _time, ...row } = thread;
			const threadId = await ctx.db.insert('discussionThreads', { ...row, ...threadFields });
			index.bindThreadId(temporaryId, threadId);
			if (witness === temporaryId) witness = threadId;
			thread = { ...thread, _id: threadId };
			result.threadId = threadId;
			if (proposalRoot) {
				await ctx.db.insert('discussionPassageClaims', {
					...owner,
					threadId,
					indexedDocumentRevision: thread.indexedDocumentRevision,
					start: thread.passageStart,
					end: thread.passageEnd
				});
				index.advanceStorageGeneration();
				index.advanceGeneration();
			}
		} else await ctx.db.patch('discussionThreads', thread._id, threadFields);
		await claim?.commit();
		if (message)
			await ctx.db.patch('discussionMessages', message._id, {
				text: messageRow.text,
				deleted: messageRow.deleted,
				unreadByTeam: messageRow.unreadByTeam,
				revision: messageRow.revision
			});
		else
			result.messageId = await ctx.db.insert('discussionMessages', {
				...messageRow,
				threadId: thread._id
			});
		await ctx.db.insert('discussionReceipts', {
			...receiptRow,
			threadId: result.threadId,
			messageId: result.messageId
		});
		await index.flush(ctx, witness, undefined, !withdrew);
		if (resuming)
			await sealReceipt(ctx, resuming, inputs, {
				state: 'complete',
				result: JSON.stringify(result)
			});
		return result;
	} catch (error) {
		if (!(error instanceof DiscussionPreparationRequired) || started) throw error;
		return defer(ctx, context, actor, 'discussion-write', input, plan, resuming);
	}
}

export async function markDiscussionSeen(
	ctx: MutationCtx,
	context: DiscussionContext,
	actor: DiscussionActor,
	input: SeenInput,
	resuming?: Doc<'operationReceipts'>
): Promise<Infer<typeof markSeenResult>> {
	context.index = await DiscussionIndex.open(ctx, context.root, () =>
		admitDiscussionWork(ctx, { reads: 1, queries: 1 })
	);
	if (!actor.profileId) throw new ConvexError('Only the company team can acknowledge messages.');
	if (
		input.messages.length > 20 ||
		input.messages.some((m) => !Number.isSafeInteger(m.revision) || m.revision < 1) ||
		new Set(input.messages.map((m) => m.messageId)).size !== input.messages.length
	)
		throw new ConvexError('Use a bounded list of distinct message revisions.');
	const prior = await priorOperation(ctx, context, actor, 'discussion-mark-seen', input, resuming);
	if (prior?.state === 'complete') {
		await requireSeenTargets(ctx, context, input);
		return JSON.parse(prior.result) as Infer<typeof markSeenResult>;
	}
	if (prior?.state === 'preparing' && !resuming) {
		await requireSeenTargets(ctx, context, input);
		return { status: 'preparing', operationId: input.operationId };
	}
	const result = { status: 'complete' as const, operationId: input.operationId };
	let plan = commandPlan(context, input, null, []),
		started = false;
	try {
		const changes: Doc<'discussionMessages'>[] = [],
			affected = new Map<
				Id<'discussionThreads'>,
				{ thread: Doc<'discussionThreads'>; count: number }
			>();
		for (const seen of input.messages) {
			await admitDiscussionWork(ctx, { reads: 3, queries: 3 });
			const message = await ctx.db.get('discussionMessages', seen.messageId);
			if (!message) continue;
			if (!ownsDiscussion(context, message)) throw new ConvexError('This message is unavailable.');
			const thread = await liveDiscussionThread(context, message.threadId);
			if (!thread) throw new ConvexError('This discussion is unavailable.');
			if (
				message.profileId ||
				message.deleted ||
				!message.unreadByTeam ||
				message.revision !== seen.revision
			)
				continue;
			changes.push(message);
			const value = affected.get(thread._id) ?? { thread, count: thread.unreadMessageCount };
			value.count--;
			affected.set(thread._id, value);
		}
		const excluded = [...affected.values()].filter((v) => v.count === 0).map((v) => v.thread);
		plan = commandPlan(
			context,
			input,
			[...affected.values()].map((v) => [v.thread._id, v.thread.unreadMessageCount, v.count]),
			excluded
		);
		const witness = await proofWitness(context, plan, resuming);
		for (const { thread, count } of affected.values())
			await context.index.prepareUnreadCount(thread, count, thread.indexedTapeLength);
		const seal = await sealWork(ctx, resuming, JSON.stringify(input), JSON.stringify(result));
		await admitTransition(
			ctx,
			plus(seal, await context.index.prepareFlush(witness), {
				documents: changes.length + affected.size + 1,
				bytes:
					changes.reduce(
						(sum, message) => sum + documentBytes({ ...message, unreadByTeam: false }),
						0
					) +
					[...affected.values()].reduce(
						(sum, value) =>
							sum + documentBytes({ ...value.thread, unreadMessageCount: value.count }),
						0
					) +
					2048,
				queries: 1,
				readDocuments: 1,
				readBytes: 2048
			})
		);
		started = true;
		for (const message of changes)
			await ctx.db.patch('discussionMessages', message._id, { unreadByTeam: false });
		for (const { thread, count } of affected.values())
			await ctx.db.patch('discussionThreads', thread._id, { unreadMessageCount: count });
		await context.index.flush(ctx, witness);
		if (resuming)
			await sealReceipt(ctx, resuming, JSON.stringify(input), {
				state: 'complete',
				result: JSON.stringify(result)
			});
		return result;
	} catch (error) {
		if (!(error instanceof DiscussionPreparationRequired) || started) throw error;
		return defer(ctx, context, actor, 'discussion-mark-seen', input, plan, resuming);
	}
}

/** Protected reattachment derives the actor from the real account/HttpOnly cookie.
 * Caller IDs and author expectations never authorize receipt access. */
export async function discussionResult(
	ctx: QueryCtx,
	context: DiscussionContext,
	actor: DiscussionActor,
	input: WriteInput
) {
	const prior = await priorOperation(
		ctx,
		context,
		actor,
		'discussion-write',
		input,
		undefined,
		true
	);
	const replay = await discussionReplay(ctx, context, actor, input.operationId, input.command);
	if (replay)
		return {
			status: 'complete' as const,
			operationId: input.operationId,
			result: JSON.stringify(replay)
		};
	if (!prior) return null;
	if (prior.state === 'complete') throw new ConvexError('This discussion is unavailable.');
	await requireWriteTarget(ctx, context, input);
	return prior.state === 'preparing'
		? { status: 'preparing' as const, operationId: input.operationId }
		: {
				status: 'failed' as const,
				operationId: input.operationId,
				error: prior.error ?? 'This operation could not complete.'
			};
}

export async function discussionSeenResult(
	ctx: QueryCtx,
	context: DiscussionContext,
	actor: DiscussionActor,
	input: SeenInput
) {
	if (input.messages.length > 20) throw new ConvexError('Use a bounded list of message revisions.');
	const prior = await priorOperation(
		ctx,
		context,
		actor,
		'discussion-mark-seen',
		input,
		undefined,
		true
	);
	if (!prior) return null;
	await requireSeenTargets(ctx, context, input);
	return prior.state === 'preparing'
		? { status: 'preparing' as const, operationId: input.operationId }
		: prior.state === 'complete'
			? { status: 'complete' as const, operationId: input.operationId, result: prior.result }
			: {
					status: 'failed' as const,
					operationId: input.operationId,
					error: prior.error ?? 'This operation could not complete.'
				};
}
