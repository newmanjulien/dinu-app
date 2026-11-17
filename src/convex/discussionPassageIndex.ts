import { ConvexError } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { DiscussionTape } from '../lib/discussions/tape';
import { buildPassageIndex, MAX_PASSAGE_INDEX_BYTES } from '../lib/discussions/passage-index';
import { assertContractDocumentManifest, contractDocumentSeal } from './contractDocuments';
import { documentBytes } from './storageCapacity';

type Source = {
	companyId: Id<'company'>;
	contractId: Id<'savedContracts'>;
	documentId: Id<'contractDocuments'>;
	documentRevision: number;
};
type IndexValue = Omit<Doc<'discussionPassageIndexes'>, '_id' | '_creationTime'>;

export async function passageIndexRow(
	ctx: QueryCtx,
	source: Source,
	manifestSeal: string
): Promise<Doc<'discussionPassageIndexes'> | null> {
	const row = await ctx.db
		.query('discussionPassageIndexes')
		.withIndex('by_documentId_and_documentRevision', (q) =>
			q.eq('documentId', source.documentId).eq('documentRevision', source.documentRevision)
		)
		.unique();
	if (!row) return null;
	if (row.companyId !== source.companyId || row.contractId !== source.contractId)
		throw new ConvexError('This contract document is unavailable.');
	return row.manifestSeal === manifestSeal ? row : null;
}

export async function currentPassageIndex(ctx: QueryCtx, source: Source) {
	const manifest = await ctx.db.get('contractDocuments', source.documentId);
	assertContractDocumentManifest(manifest, {
		companyId: source.companyId,
		contractId: source.contractId
	});
	if (manifest.stage && !manifest.stage.sealed)
		throw new ConvexError('This contract document is unavailable.');
	const manifestSeal = contractDocumentSeal(manifest);
	return {
		manifestSeal,
		row: await passageIndexRow(ctx, source, manifestSeal)
	};
}

export function plannedPassageIndex(
	source: Source,
	manifestSeal: string,
	tape: DiscussionTape
): { value: IndexValue; bytes: number } | null {
	const data = buildPassageIndex(tape);
	if (data.byteLength > MAX_PASSAGE_INDEX_BYTES) return null;
	const value = { ...source, manifestSeal, data };
	return {
		value,
		bytes: documentBytes({ ...value, _id: 'x'.repeat(32), _creationTime: 0 })
	};
}

export async function storePassageIndex(ctx: MutationCtx, value: IndexValue) {
	const existing = await ctx.db
		.query('discussionPassageIndexes')
		.withIndex('by_documentId_and_documentRevision', (q) =>
			q.eq('documentId', value.documentId).eq('documentRevision', value.documentRevision)
		)
		.unique();
	if (existing) {
		if (existing.companyId !== value.companyId || existing.contractId !== value.contractId)
			throw new ConvexError('This contract document is unavailable.');
		if (existing.manifestSeal === value.manifestSeal) return;
		await ctx.db.replace('discussionPassageIndexes', existing._id, value);
	} else await ctx.db.insert('discussionPassageIndexes', value);
}

export function supportedPassageIndex(data: ArrayBuffer) {
	return data.byteLength <= MAX_PASSAGE_INDEX_BYTES;
}
