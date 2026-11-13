import type { PaginationOptions } from 'convex/server';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { chunkEntries } from './chunks';
import type { NativeEmailEntry } from './emailValidators';
import { receiptChunkFingerprint, receiptSectionHash } from './operationReceipts';
import { documentBytes } from './storageCapacity';
import { canonicalJson } from '../lib/document/canonical-json';

export const snapshotSeed = (ownerKey: string, generation: number) =>
	receiptChunkFingerprint(JSON.stringify([ownerKey, generation]));

/** Prepare all writes before the caller reserves its complete transaction. */
export function planSnapshotChunks(
	companyId: Id<'company'>,
	deliveryId: Id<'emailDeliveries'>,
	generation: number,
	entries: NativeEmailEntry[],
	start: { order: number; hash: string }
) {
	const groups = chunkEntries(
		entries,
		(entries) => ({
			companyId,
			deliveryId,
			generation,
			order: 0,
			entries,
			fingerprint: 'x'.repeat(64),
			previousHash: 'x'.repeat(64),
			hash: 'x'.repeat(64),
			bytes: 0
		}),
		'Email snapshot entry is too large.'
	);
	let hash = start.hash,
		bytes = 0;
	const rows = groups.map((entries, offset) => {
		const data = canonicalJson(entries),
			fingerprint = receiptChunkFingerprint(data),
			order = start.order + offset,
			previousHash = hash;
		hash = receiptSectionHash(previousHash, order, fingerprint, entries.length);
		const row = {
			companyId,
			deliveryId,
			generation,
			order,
			entries,
			fingerprint,
			previousHash,
			hash,
			bytes: new TextEncoder().encode(data).length
		};
		bytes += row.bytes;
		return row;
	});
	return {
		rows,
		hash,
		bytes,
		count: entries.length,
		work: {
			writes: rows.length,
			bytes: rows.reduce(
				(n, row) => n + documentBytes({ ...row, _id: 'x'.repeat(32), _creationTime: 0 }),
				0
			)
		}
	};
}
export async function writeSnapshotChunks(
	ctx: MutationCtx,
	plan: ReturnType<typeof planSnapshotChunks>
) {
	for (const row of plan.rows) await ctx.db.insert('emailSelectionChunks', row);
}

/** Native pagination survives short and empty nonterminal pages. */
export async function snapshotPage(
	ctx: QueryCtx,
	delivery: Doc<'emailDeliveries'>,
	paginationOpts: PaginationOptions
) {
	if (!('snapshot' in delivery)) throw new Error('Invitation has no contract snapshot.');
	const page = await ctx.db
		.query('emailSelectionChunks')
		.withIndex('by_deliveryId_and_generation_and_order', (q) =>
			q.eq('deliveryId', delivery._id).eq('generation', delivery.snapshot.generation)
		)
		.paginate(paginationOpts);
	for (const row of page.page) {
		const data = canonicalJson(row.entries);
		if (
			row.companyId !== delivery.companyId ||
			row.deliveryId !== delivery._id ||
			row.generation !== delivery.snapshot.generation ||
			receiptChunkFingerprint(data) !== row.fingerprint ||
			new TextEncoder().encode(data).length !== row.bytes ||
			receiptSectionHash(row.previousHash, row.order, row.fingerprint, row.entries.length) !==
				row.hash
		)
			throw new Error('Email snapshot ownership or immutable hash is invalid.');
	}
	return page;
}
