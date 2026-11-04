import type { MutationCtx } from './_generated/server';
import type { Infer } from 'convex/values';
import type { historicalItem } from './playbookValidators';
import {
	normalizePlaybookItem,
	type PlaybookItem,
	type StoredPlaybookItem
} from '../lib/playbook/model';
import type { Doc, Id } from './_generated/dataModel';
import { documentBytes, publicationCapacity } from './templateCapacity';

export type StoredHistoricalItem = Infer<typeof historicalItem>;
export type HistoricalItem = Omit<StoredHistoricalItem, 'trigger' | 'concessions'> & PlaybookItem;
type BusinessItem = Pick<StoredPlaybookItem, 'trigger' | 'instructions' | 'concessions'>;

/** Normalize legacy source targets as content crosses database/API boundaries. */
export function businessItem(item: BusinessItem | PlaybookItem): PlaybookItem {
	const { trigger, instructions, concessions } = normalizePlaybookItem(item);
	return { trigger, ...(instructions === undefined ? {} : { instructions }), concessions };
}
export function snapshotItem(item: StoredHistoricalItem | HistoricalItem): HistoricalItem {
	return {
		...businessItem(item),
		_id: item._id,
		_creationTime: item._creationTime,
		companyId: item.companyId,
		revision: item.revision
	};
}
export function itemRevision(saved: StoredHistoricalItem | HistoricalItem) {
	return {
		companyId: saved.companyId,
		itemId: saved._id,
		itemCreatedAt: saved._creationTime,
		revision: saved.revision,
		body: businessItem(saved)
	};
}
export function historicalRevision(saved: Doc<'playbookItemRevisions'>): HistoricalItem {
	return {
		...businessItem(saved.body),
		_id: saved.itemId,
		_creationTime: saved.itemCreatedAt,
		companyId: saved.companyId,
		revision: saved.revision
	};
}
export async function storeItemRevision(
	ctx: MutationCtx,
	saved: StoredHistoricalItem | HistoricalItem,
	draftVersionId?: Id<'templateVersions'>
) {
	const revision = { ...itemRevision(saved), draftVersionId };
	await publicationCapacity(ctx, { documents: 1, bytes: documentBytes(revision) });
	return ctx.db.insert('playbookItemRevisions', revision);
}

/** A draft-only revision can be replaced because no saved contract can reference it. */
export async function replaceDraftItemRevision(
	ctx: MutationCtx,
	revisionId: Id<'playbookItemRevisions'>,
	saved: StoredHistoricalItem | HistoricalItem,
	draftVersionId: Id<'templateVersions'>
) {
	const revision = { ...itemRevision(saved), draftVersionId };
	await publicationCapacity(ctx, { documents: 1, bytes: documentBytes(revision) });
	await ctx.db.replace('playbookItemRevisions', revisionId, revision);
	return revisionId;
}

/** A newly allocated revision becomes mutable only after its draft version is known. */
export async function markDraftItemRevision(
	ctx: MutationCtx,
	revisionId: Id<'playbookItemRevisions'>,
	draftVersionId: Id<'templateVersions'>
) {
	const revision = await ctx.db.get('playbookItemRevisions', revisionId);
	if (!revision || revision.draftVersionId) return;
	await publicationCapacity(ctx, {
		documents: 1,
		bytes: documentBytes({ ...revision, draftVersionId })
	});
	await ctx.db.patch('playbookItemRevisions', revisionId, { draftVersionId });
}

/** Allocation and the revision head commit in the same publication transaction. */
export async function createAuthoringItem(
	ctx: MutationCtx,
	content: Omit<Doc<'playbookItems'>, '_id' | '_creationTime' | 'revision' | 'publishedRevisionId'>
) {
	const created = { ...content, revision: 1 };
	const bytes = documentBytes(created);
	await publicationCapacity(ctx, {
		documents: 1,
		bytes,
		queries: 1,
		readDocuments: 1,
		readBytes: bytes
	});
	const id = await ctx.db.insert('playbookItems', created);
	const saved = (await ctx.db.get('playbookItems', id))!;
	const publishedRevisionId = await storeItemRevision(ctx, saved);
	const next = { ...saved, publishedRevisionId };
	await publicationCapacity(ctx, { documents: 1, bytes: documentBytes(next) });
	await ctx.db.patch('playbookItems', id, { publishedRevisionId });
	return next;
}
