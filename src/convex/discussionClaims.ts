import { ConvexError } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { changeHead } from './contractChanges';
import { DiscussionIndex } from './discussionIndex';
import { DiscussionPreparationRequired, admitDiscussionWork } from './discussionMaps';
import type { PassageInterval } from '../lib/discussions/tape';

/** Raw and supported unresolved roots claim their passage. Decline releases
 * only the exact current root's claim; a later root revision is unresolved. */
export async function unresolvedProposal(
	ctx: QueryCtx,
	index: DiscussionIndex,
	thread: Doc<'discussionThreads'>
) {
	if (!index.owned(thread) || thread.type !== 'proposal' || !(await index.interval(thread)))
		return false;
	const root = await ctx.db
		.query('discussionMessages')
		.withIndex('by_threadId_and_reply', (q) => q.eq('threadId', thread._id).eq('reply', false))
		.unique();
	if (
		!root ||
		root.companyId !== index.owner.companyId ||
		root.contractId !== index.owner.contractId ||
		root.deleted
	)
		return false;
	const head = await changeHead(ctx, { root: index.root }, 'buyer-proposal', thread._id, index);
	const current = head?.current;
	return !(
		current?.kind === 'buyer-proposal' &&
		current.source.rootMessageId === root._id &&
		current.source.rootRevision === root.revision &&
		head?.head.status !== 'pending'
	);
}

/** Shared by create, declined-root edit/reopen, support and replacement.
 * Skip at most 32 stale candidates across the entire command. */
export async function admitProposalClaim(
	ctx: MutationCtx,
	index: DiscussionIndex,
	incoming: PassageInterval,
	currentTapeLength: number,
	ownThread?: Doc<'discussionThreads'>
) {
	let stale = 0;
	const cohorts = index.events.map((event) => ({
		revision: event.fromRevision,
		length: event.map.beforeLength
	}));
	cohorts.push({ revision: index.root.documentRevision, length: currentTapeLength });
	for (const cohort of cohorts) {
		for await (const gap of index.gaps(cohort.revision, cohort.length)) {
			const currentStart = Math.max(incoming.start, gap.currentStart),
				currentEnd = Math.min(incoming.end, gap.currentEnd);
			if (currentStart >= currentEnd) continue;
			const start = gap.start + currentStart - gap.currentStart,
				end = gap.start + currentEnd - gap.currentStart;
			await admitDiscussionWork(ctx, { reads: 34, queries: 1 });
			const candidates = await ctx.db
				.query('discussionPassageClaims')
				.withIndex('by_contractId_and_indexedDocumentRevision_and_start', (q) =>
					q
						.eq('contractId', index.owner.contractId)
						.eq('indexedDocumentRevision', cohort.revision)
						.lt('start', end)
				)
				.order('desc')
				.take(34);
			let resolved = false;
			for (const claim of candidates) {
				if (claim.companyId !== index.owner.companyId)
					throw new Error('Discussion claim ownership is invalid.');
				if (claim.threadId === ownThread?._id) continue;
				await admitDiscussionWork(ctx, { reads: 5, queries: 5 });
				const thread = await index.thread(claim.threadId);
				const valid = thread && (await index.interval(thread));
				if (!valid) {
					if (
						!thread ||
						thread.tombstoned ||
						!index.events.some((event) => event.fromRevision >= claim.indexedDocumentRevision)
					)
						throw new Error('A stale claim has no durable invalidation owner.');
					if (stale++ >= 32) throw new DiscussionPreparationRequired('claim-probe');
					continue;
				}
				if (
					thread.indexedDocumentRevision !== claim.indexedDocumentRevision ||
					thread.passageStart !== claim.start ||
					thread.passageEnd !== claim.end ||
					!(await unresolvedProposal(ctx, index, thread))
				)
					throw new Error('A live proposal claim does not match its unresolved root.');
				if (claim.end > start)
					throw new ConvexError(
						'There is already a proposed change on this passage. Resolve it before proposing another.'
					);
				resolved = true;
				break;
			}
			if (!resolved && candidates.length === 34)
				throw new DiscussionPreparationRequired('claim-probe');
		}
	}
}

/** A claim mutation is completely read/admitted before a native insertion. */
export async function prepareProposalClaim(
	ctx: MutationCtx,
	index: DiscussionIndex,
	thread: Doc<'discussionThreads'>,
	interval: PassageInterval | null,
	tapeLength: number
) {
	if (!index.owned(thread) || thread.type !== 'proposal')
		throw new Error('Invalid proposal claim owner.');
	if (interval) await admitProposalClaim(ctx, index, interval, tapeLength, thread);
	const existing = await ctx.db
		.query('discussionPassageClaims')
		.withIndex('by_threadId', (q) => q.eq('threadId', thread._id))
		.unique();
	if (
		existing &&
		(existing.companyId !== index.owner.companyId ||
			existing.contractId !== index.owner.contractId ||
			existing.indexedDocumentRevision !== thread.indexedDocumentRevision ||
			existing.start !== thread.passageStart ||
			existing.end !== thread.passageEnd)
	)
		throw new Error('Proposal claim coordinates changed.');
	const row = {
		...index.owner,
		threadId: thread._id,
		indexedDocumentRevision: thread.indexedDocumentRevision,
		start: thread.passageStart,
		end: thread.passageEnd
	};
	const changed = Boolean(interval) !== Boolean(existing);
	return {
		work: { documents: Number(changed), bytes: changed ? 1024 : 0 },
		commit: async () => {
			if (!changed) return;
			if (interval) await ctx.db.insert('discussionPassageClaims', row);
			else if (existing) await ctx.db.delete('discussionPassageClaims', existing._id);
			index.advanceStorageGeneration();
			index.advanceGeneration();
		}
	};
}
