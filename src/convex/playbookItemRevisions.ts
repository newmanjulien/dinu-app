import type { MutationCtx } from './_generated/server';
import type { HistoricalItem } from './baselineStorage';
import { documentBytes, publicationCapacity } from './templateCapacity';

export async function storeItemRevision(ctx: MutationCtx, saved: HistoricalItem) {
	const revision = { companyId: saved.companyId, itemId: saved._id, item: saved };
	await publicationCapacity(ctx, { documents: 1, bytes: documentBytes(revision) });
	return ctx.db.insert('playbookItemRevisions', revision);
}

/** Authoring inserts own their revision head, including during seed staging. */
export async function createAuthoringItem(
	ctx: MutationCtx,
	content: Omit<HistoricalItem, '_id' | '_creationTime' | 'revision'>
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
