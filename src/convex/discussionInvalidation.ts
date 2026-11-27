import { getConvexSize, v, type Infer } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import {
	buildConcessionChangeSet,
	footprintAffectedByChanges,
	type ConcessionChangeSet
} from '../lib/discussions/anchors';
import type { ValidationSourceFacts } from '../lib/document/validation-source';
import { toDocumentOverlay } from '../lib/playbook/document-overlay';
import { isRepItem } from '../lib/playbook/model';
import { cleanupBudget } from './cleanup';
import { writeDirectoryUnread } from './contractDirectory';
import type { HistoricalItem } from './playbookItemRevisions';
import { snapshotReader } from './templates';
import { accountMessage, accountThread } from './discussionCapacity';

const THREAD_PAGE_SIZE = 16;
const THREAD_PAGE_MAX_BYTES = 2 * 1024 * 1024;

export type PreloadedInvalidation = {
	itemsById?: ReadonlyMap<Id<'playbookItems'>, HistoricalItem>;
	facts?: ValidationSourceFacts;
};

const serializedChangeSet = v.object({
	removedConcessions: v.array(v.string()),
	textRanges: v.array(v.object({ start: v.number(), end: v.number() })),
	insertedAfterBlocks: v.array(v.string()),
	insertedBoundaryOrdinals: v.array(v.number()),
	splitBreaks: v.array(v.object({ position: v.number(), ordinal: v.number() })),
	removedBlocks: v.array(v.string()),
	toggledRemovedOrdinals: v.array(v.number())
});

type SerializedChangeSet = Infer<typeof serializedChangeSet>;

function serializeChangeSet(changeSet: ConcessionChangeSet): SerializedChangeSet {
	return {
		removedConcessions: [...changeSet.removedConcessions],
		textRanges: [...changeSet.textRanges],
		insertedAfterBlocks: [...changeSet.insertedAfterBlocks],
		insertedBoundaryOrdinals: [...changeSet.insertedBoundaryOrdinals],
		splitBreaks: [...changeSet.splitBreaks],
		removedBlocks: [...changeSet.removedBlocks],
		toggledRemovedOrdinals: [...changeSet.toggledRemovedOrdinals]
	};
}

function parseChangeSet(changeSet: SerializedChangeSet): ConcessionChangeSet {
	return {
		removedConcessions: new Set(changeSet.removedConcessions),
		textRanges: changeSet.textRanges,
		insertedAfterBlocks: new Set(changeSet.insertedAfterBlocks),
		insertedBoundaryOrdinals: changeSet.insertedBoundaryOrdinals,
		splitBreaks: changeSet.splitBreaks,
		removedBlocks: new Set(changeSet.removedBlocks),
		toggledRemovedOrdinals: changeSet.toggledRemovedOrdinals
	};
}

/** O(1) unread sync via `by_contractId_and_hasUnread`. Every stored thread is live. */
export async function refreshDirectoryUnread(ctx: MutationCtx, contractId: Id<'savedContracts'>) {
	const unread = await ctx.db
		.query('discussionThreads')
		.withIndex('by_contractId_and_hasUnread', (q) =>
			q.eq('contractId', contractId).eq('hasUnread', true)
		)
		.first();
	await writeDirectoryUnread(ctx, contractId, Boolean(unread), true);
}

/**
 * Delete a verified thread row synchronously so live queries and unread state see it vanish
 * atomically, then drain its messages under transaction budget limits.
 */
export async function deleteThreadAndMessages(
	ctx: MutationCtx,
	threadId: Id<'discussionThreads'>
): Promise<void> {
	const thread = await ctx.db.get('discussionThreads', threadId);
	if (!thread) return;
	await accountThread(ctx, thread, -1);
	await ctx.db.delete('discussionThreads', threadId);
	const { drain } = cleanupBudget(ctx);
	const done = await drain(
		'discussionMessages',
		ctx.db
			.query('discussionMessages')
			.withIndex('by_threadId_and_reply', (q) => q.eq('threadId', threadId)),
		{ beforeDelete: (message) => accountMessage(ctx, message, -1) }
	);
	if (!done) {
		await ctx.scheduler.runAfter(0, internal.discussionInvalidation.drainThreadMessages, {
			threadIds: [threadId]
		});
	}
}

/** Cursorless batched message drainer scheduled after synchronous thread deletion. */
export const drainThreadMessages = internalMutation({
	args: {
		threadIds: v.array(v.id('discussionThreads'))
	},
	returns: v.null(),
	handler: async (ctx, { threadIds }) => {
		const { drain } = cleanupBudget(ctx);
		for (let i = 0; i < threadIds.length; i++) {
			const threadId = threadIds[i];
			const done = await drain(
				'discussionMessages',
				ctx.db
					.query('discussionMessages')
					.withIndex('by_threadId_and_reply', (q) => q.eq('threadId', threadId)),
				{ beforeDelete: (message) => accountMessage(ctx, message, -1) }
			);
			if (!done) {
				await ctx.scheduler.runAfter(0, internal.discussionInvalidation.drainThreadMessages, {
					threadIds: threadIds.slice(i)
				});
				return null;
			}
		}
		return null;
	}
});

/**
 * Zero-skip page processor: check budget BEFORE paginating, process 100% of each small page
 * synchronously (never reading messages inline), batch-schedule one message drainer, and
 * forward `page.continueCursor` only after every row on the page has been evaluated.
 */
async function deleteAffectedPage(
	ctx: MutationCtx,
	contractId: Id<'savedContracts'>,
	maxContentRevision: number,
	changeSet: ConcessionChangeSet,
	serialized: SerializedChangeSet,
	cursor: string | null
) {
	const budget = cleanupBudget(ctx, {
		minScheduled: 2,
		minScheduledArgsBytes: getConvexSize(serialized) + 2048
	});
	if (await budget.exhausted()) {
		await ctx.scheduler.runAfter(0, internal.discussionInvalidation.continueDeleteAffected, {
			contractId,
			maxContentRevision,
			changeSet: serialized,
			cursor
		});
		return;
	}

	const page = await ctx.db
		.query('discussionThreads')
		.withIndex('by_contractId', (q) => q.eq('contractId', contractId))
		.paginate({
			cursor,
			numItems: THREAD_PAGE_SIZE,
			maximumBytesRead: THREAD_PAGE_MAX_BYTES
		});

	const deletedThreadIds: Id<'discussionThreads'>[] = [];
	for (const thread of page.page) {
		if (thread.contentRevision > maxContentRevision) continue;
		if (!footprintAffectedByChanges(thread.footprint, changeSet)) continue;
		await accountThread(ctx, thread, -1);
		await ctx.db.delete('discussionThreads', thread._id);
		deletedThreadIds.push(thread._id);
	}

	if (deletedThreadIds.length > 0) {
		await refreshDirectoryUnread(ctx, contractId);
		await ctx.scheduler.runAfter(0, internal.discussionInvalidation.drainThreadMessages, {
			threadIds: deletedThreadIds
		});
	}

	if (!page.isDone) {
		await ctx.scheduler.runAfter(0, internal.discussionInvalidation.continueDeleteAffected, {
			contractId,
			maxContentRevision,
			changeSet: serialized,
			cursor: page.continueCursor
		});
	}
}

/** Hard-delete comments whose structural footprint overlaps approved Playbook concession changes. */
export async function deleteAffectedComments(
	ctx: MutationCtx,
	contract: Doc<'savedContracts'>,
	prevConcessions: Record<string, string>,
	nextConcessions: Record<string, string>,
	maxContentRevision: number,
	preloaded?: PreloadedInvalidation
) {
	const allItemIds = [
		...new Set([...Object.keys(prevConcessions), ...Object.keys(nextConcessions)])
	] as Id<'playbookItems'>[];
	const anyChanged = allItemIds.some((id) => prevConcessions[id] !== nextConcessions[id]);
	if (!anyChanged) return;

	const firstThread = await ctx.db
		.query('discussionThreads')
		.withIndex('by_contractId', (q) => q.eq('contractId', contract._id))
		.first();
	if (!firstThread) return;

	const missingIds = allItemIds.filter((id) => !preloaded?.itemsById?.has(id));
	let facts = preloaded?.facts;
	const mergedItems = new Map<Id<'playbookItems'>, HistoricalItem>(preloaded?.itemsById);

	if (missingIds.length > 0 || !facts) {
		const reader = await snapshotReader(ctx, contract);
		const [loadedFacts, loadedItems] = await Promise.all([
			facts ? Promise.resolve(facts) : reader.readSourceFacts(),
			missingIds.length > 0 ? reader.readItemsByIds(missingIds) : Promise.resolve([])
		]);
		facts = loadedFacts;
		for (const item of loadedItems) mergedItems.set(item._id, item);
	}

	const overlays = allItemIds.flatMap((id) => {
		const item = mergedItems.get(id);
		return item && isRepItem(item) ? [toDocumentOverlay(item)] : [];
	});
	const changeSet = buildConcessionChangeSet(facts, prevConcessions, nextConcessions, overlays);
	await deleteAffectedPage(
		ctx,
		contract._id,
		maxContentRevision,
		changeSet,
		serializeChangeSet(changeSet),
		null
	);
}

export const continueDeleteAffected = internalMutation({
	args: {
		contractId: v.id('savedContracts'),
		maxContentRevision: v.number(),
		changeSet: serializedChangeSet,
		cursor: v.union(v.string(), v.null())
	},
	returns: v.null(),
	handler: async (ctx, { contractId, maxContentRevision, changeSet, cursor }) => {
		await deleteAffectedPage(
			ctx,
			contractId,
			maxContentRevision,
			parseChangeSet(changeSet),
			changeSet,
			cursor
		);
		return null;
	}
});
