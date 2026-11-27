import { ConvexError, getConvexSize } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { DISCUSSION_MESSAGE_LIMIT, DISCUSSION_THREAD_LIMIT } from '../lib/discussions/limits';

// Reserve room for authorization reads and the expanded public author projections.
const MAX_DISCUSSION_BYTES = 4 * 1024 * 1024;
type Owner = { companyId: Id<'company'>; contractId: Id<'savedContracts'> };
type Delta = { threads?: number; messages?: number; bytes: number };

/** Count stored rows, including messages awaiting asynchronous thread cleanup. */
async function adjust(ctx: MutationCtx, owner: Owner, delta: Delta) {
	const current = await ctx.db
		.query('discussionCapacity')
		.withIndex('by_contractId', (q) => q.eq('contractId', owner.contractId))
		.unique();
	// A delayed message drainer may run after parent erasure removed the entire family.
	if (!current && delta.bytes < 0) return;
	if (current && current.companyId !== owner.companyId)
		throw new Error('Invalid discussion capacity ownership.');
	const next = {
		companyId: owner.companyId,
		contractId: owner.contractId,
		threads: (current?.threads ?? 0) + (delta.threads ?? 0),
		messages: (current?.messages ?? 0) + (delta.messages ?? 0),
		bytes: (current?.bytes ?? 0) + delta.bytes
	};
	if (next.threads < 0 || next.messages < 0 || next.bytes < 0)
		throw new Error('Invalid discussion capacity accounting.');
	if (next.threads > DISCUSSION_THREAD_LIMIT || next.messages > DISCUSSION_MESSAGE_LIMIT)
		throw new ConvexError(
			'This contract has reached its comment limit. Remove an older discussion before adding another message.'
		);
	if (next.bytes > MAX_DISCUSSION_BYTES)
		throw new ConvexError(
			'This contract has reached its comment storage limit. Shorten this message or remove an older discussion.'
		);
	if (next.threads === 0 && next.messages === 0) {
		if (current) await ctx.db.delete('discussionCapacity', current._id);
	} else if (current) await ctx.db.replace('discussionCapacity', current._id, next);
	else await ctx.db.insert('discussionCapacity', next);
}

export function accountThread(
	ctx: MutationCtx,
	thread: Doc<'discussionThreads'>,
	direction: 1 | -1
) {
	return adjust(ctx, thread, { threads: direction, bytes: direction * getConvexSize(thread) });
}
export function accountMessage(
	ctx: MutationCtx,
	message: Doc<'discussionMessages'>,
	direction: 1 | -1
) {
	return adjust(ctx, message, { messages: direction, bytes: direction * getConvexSize(message) });
}
export function accountMessageEdit(
	ctx: MutationCtx,
	previous: Doc<'discussionMessages'>,
	next: Doc<'discussionMessages'>
) {
	return adjust(ctx, previous, { bytes: getConvexSize(next) - getConvexSize(previous) });
}
