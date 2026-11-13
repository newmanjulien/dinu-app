import type { Doc } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import type { DiscussionIndex } from './discussionIndex';
import type { TransitionManifest } from './discussionMaps';

/** Shared current-support predicate. Applied changes bypass this predicate entirely;
 * their immutable reversal/approval evidence has no live-source dependency. */
export async function effectiveBuyerSource(
	ctx: QueryCtx,
	index: DiscussionIndex,
	change: Pick<
		Extract<Doc<'contractChanges'>, { kind: 'buyer-proposal' }>,
		'companyId' | 'contractId' | 'kind' | 'key' | 'source'
	>,
	additional?: TransitionManifest
) {
	if (
		change.companyId !== index.owner.companyId ||
		change.contractId !== index.owner.contractId ||
		change.key !== change.source.threadId
	)
		throw new Error('Buyer support ownership is invalid.');
	const thread = await index.thread(change.source.threadId);
	if (!thread || thread.type !== 'proposal' || !(await index.interval(thread, additional)))
		return null;
	const root = await ctx.db
		.query('discussionMessages')
		.withIndex('by_threadId_and_reply', (q) => q.eq('threadId', thread._id).eq('reply', false))
		.unique();
	return root &&
		root._id === change.source.rootMessageId &&
		root.companyId === index.owner.companyId &&
		root.contractId === index.owner.contractId &&
		root.threadId === thread._id &&
		!root.reply &&
		!root.deleted &&
		root.revision === change.source.rootRevision
		? thread
		: null;
}
