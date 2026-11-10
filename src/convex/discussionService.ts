import { ConvexError, type Infer } from 'convex/values';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { liveCompanyMember, requireAccount, membershipForProfile } from './auth';
import { contractReader } from './contractReader';
import { concessionSelections } from '../lib/contract/applications';
import { DocumentCompositionEngine } from '../lib/document/compose';
import { toDocumentOverlay } from '../lib/playbook/document-overlay';
import { anchorPassage, validDiscussionAnchor } from '../lib/discussions/anchors';
import type { discussionCommand, publicAuthor } from '../lib/discussions/validators';
import { consumeDiscussionQuota } from './buyerActivityQuota';
import { assertStorageCapacity } from './storageCapacity';

export const fingerprint = (value: string) => bytesToHex(sha256(new TextEncoder().encode(value)));
export type DiscussionActor = { key: string; profileId?: Doc<'profiles'>['_id'] };
export async function discussionActor(
	ctx: QueryCtx,
	contract: Pick<Doc<'savedContracts'>, '_id' | 'companyId'>,
	browserId?: string
): Promise<DiscussionActor> {
	if (await ctx.auth.getUserIdentity()) {
		const { profile } = await requireAccount(ctx);
		const membership = await membershipForProfile(ctx, profile._id);
		if (membership?.companyId === contract.companyId)
			return {
				key: fingerprint(JSON.stringify([contract._id, 'account', profile._id])),
				profileId: profile._id
			};
	}
	if (!browserId || !/^[a-f0-9-]{36}$/u.test(browserId))
		throw new ConvexError('Reopen the discussion and try again.');
	return { key: fingerprint(JSON.stringify([contract._id, 'buyer', browserId])) };
}
export async function authorView(
	ctx: QueryCtx,
	companyId: Doc<'company'>['_id'],
	actor: DiscussionActor
): Promise<Infer<typeof publicAuthor>> {
	const profile = actor.profileId ? await liveCompanyMember(ctx, companyId, actor.profileId) : null;
	return {
		key: actor.key,
		name: actor.profileId ? profile?.name || 'Former colleague' : 'Buyer',
		avatarUrl: profile?.avatarId ? await ctx.storage.getUrl(profile.avatarId) : null,
		buyer: !actor.profileId
	};
}
export function messageProjector(ctx: QueryCtx) {
	const authors = new Map<string, Promise<Infer<typeof publicAuthor>>>();
	return async (message: Doc<'discussionMessages'>) => {
		const cacheKey = JSON.stringify([message.companyId, message.profileId ?? null]);
		let author = authors.get(cacheKey);
		if (!author) {
			author = authorView(ctx, message.companyId, { key: '', profileId: message.profileId });
			authors.set(cacheKey, author);
		}
		return {
			id: message._id,
			text: message.deleted ? '' : message.text,
			revision: message.revision,
			deleted: message.deleted,
			createdAt: message._creationTime,
			author: { ...(await author), key: message.authorKey }
		};
	};
}
export async function composedContract(
	ctx: QueryCtx,
	contract: Doc<'savedContracts'>,
	selections = concessionSelections(contract.applications)
) {
	const reader = await contractReader(ctx, contract);
	const [blocks, items, compiled] = await Promise.all([
		reader.blocks(),
		reader.releasedItems(selections),
		reader.compiled()
	]);
	const engine = new DocumentCompositionEngine(blocks, compiled.index);
	const resolved = [
		...engine.compose({
			items: items.map(toDocumentOverlay),
			activeConcessions: selections,
			view: 'effective'
		})
	];
	return { reader, compiled, blocks, items, engine, resolved };
}
function validText(text: string) {
	if (!text.trim() || text.length > 20_000)
		throw new ConvexError('Enter a message of 20,000 characters or fewer.');
}
export async function writeDiscussion(
	ctx: MutationCtx,
	contract: Doc<'savedContracts'>,
	actor: DiscussionActor,
	operationId: string,
	command: Infer<typeof discussionCommand>,
	revision: number,
	selections = concessionSelections(contract.applications)
) {
	if (!/^[a-zA-Z0-9-]{1,100}$/u.test(operationId))
		throw new ConvexError('Invalid message operation.');
	const hash = fingerprint(JSON.stringify(command));
	const replay = await ctx.db
		.query('discussionReceipts')
		.withIndex('by_contractId_and_actorKey_and_operationId', (q) =>
			q.eq('contractId', contract._id).eq('actorKey', actor.key).eq('operationId', operationId)
		)
		.unique();
	if (replay) {
		if (replay.fingerprint !== hash)
			throw new ConvexError('This message operation was already used.');
		return { threadId: replay.threadId, messageId: replay.messageId };
	}
	if (command.kind !== 'delete') validText(command.text);
	if (
		!(await consumeDiscussionQuota(
			ctx,
			{ companyId: contract.companyId, contractId: contract._id },
			actor.key
		))
	)
		throw new ConvexError('Too many messages. Try again shortly.');
	const owner = { companyId: contract.companyId, contractId: contract._id };
	await assertStorageCapacity(ctx, { documents: 3, bytes: 150_000 });
	let threadId: Doc<'discussionThreads'>['_id'], messageId!: Doc<'discussionMessages'>['_id'];
	if (command.kind === 'create') {
		if (command.revision !== revision)
			throw new ConvexError(
				'This passage changed. Select the current wording to comment. Your draft is still here.'
			);
		if (!validDiscussionAnchor(command.anchor)) throw new ConvexError('Select a shorter passage.');
		const composed = await composedContract(ctx, contract, selections);
		if (!anchorPassage(composed.resolved, command.anchor))
			throw new ConvexError('This passage changed. Select the current wording.');
		threadId = await ctx.db.insert('discussionThreads', {
			...owner,
			anchor: command.anchor,
			type: command.type,
			applied: false
		});
	} else if (command.kind === 'reply') {
		const thread = await ctx.db.get('discussionThreads', command.threadId);
		if (!thread || thread.contractId !== contract._id || thread.companyId !== contract.companyId)
			throw new ConvexError('This discussion is unavailable.');
		threadId = thread._id;
	} else {
		const message = await ctx.db.get('discussionMessages', command.messageId);
		if (
			!message ||
			message.contractId !== contract._id ||
			message.companyId !== contract.companyId ||
			message.authorKey !== actor.key
		)
			throw new ConvexError('Only the author can change this message.');
		if (message.deleted || message.revision !== command.expectedRevision)
			throw new ConvexError('This message changed. Refresh before editing it.');
		threadId = message.threadId;
		messageId = message._id;
		await ctx.db.patch('discussionMessages', messageId, {
			text: command.kind === 'delete' ? '' : command.text,
			deleted: command.kind === 'delete',
			revision: message.revision + 1
		});
		if (!message.reply && command.kind === 'edit')
			await ctx.db.patch('discussionThreads', threadId, { applied: false });
	}
	if (command.kind === 'create' || command.kind === 'reply')
		messageId = await ctx.db.insert('discussionMessages', {
			...owner,
			threadId,
			reply: command.kind === 'reply',
			authorKey: actor.key,
			profileId: actor.profileId,
			text: command.text,
			revision: 1,
			deleted: false,
			createdAt: Date.now()
		});
	await ctx.db.insert('discussionReceipts', {
		...owner,
		actorKey: actor.key,
		operationId,
		fingerprint: hash,
		threadId,
		messageId
	});
	return { threadId, messageId };
}
