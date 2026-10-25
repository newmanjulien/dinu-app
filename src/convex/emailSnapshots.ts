import { getDocumentSize, v, type Value } from 'convex/values';
import { internalQuery, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { emailSelection, type EmailSelection } from './emailValidators';
import { snapshotReader } from './templates';

const CHUNK_BYTES = 128 * 1024;
export function chunks<Entry extends Value>(entries: Entry[]): Entry[][] {
	const result: Entry[][] = [];
	let current: Entry[] = [];
	let bytes = 1024;
	for (const entry of entries) {
		const size = getDocumentSize({ entry });
		if (size + 1024 > CHUNK_BYTES) throw new Error('Email snapshot entry is too large.');
		if (bytes + size > CHUNK_BYTES) {
			result.push(current);
			current = [];
			bytes = 1024;
		}
		current.push(entry);
		bytes += size;
	}
	if (current.length) result.push(current);
	return result;
}

export async function storeSelections(
	ctx: MutationCtx,
	companyId: Id<'company'>,
	deliveryId: Id<'emailDeliveries'>,
	entries: EmailSelection[]
) {
	for (const [order, selections] of chunks(entries).entries())
		await ctx.db.insert('emailSnapshots', { companyId, deliveryId, order, selections });
}
export async function selectionsFor(ctx: QueryCtx, deliveryId: Id<'emailDeliveries'>) {
	const rows = await ctx.db
		.query('emailSnapshots')
		.withIndex('by_deliveryId_and_order', (q) => q.eq('deliveryId', deliveryId))
		.take(32);
	if (rows.length === 32) throw new Error('Email snapshot exceeds its bounds.');
	return rows.flatMap((row) => row.selections);
}
export async function deleteSelections(ctx: MutationCtx, deliveryId: Id<'emailDeliveries'>) {
	const rows = await ctx.db
		.query('emailSnapshots')
		.withIndex('by_deliveryId_and_order', (q) => q.eq('deliveryId', deliveryId))
		.take(32);
	for (const row of rows) await ctx.db.delete('emailSnapshots', row._id);
}

export const descriptions = internalQuery({
	args: {
		companyId: v.id('company'),
		templateVersionId: v.id('templateVersions'),
		selections: v.array(emailSelection)
	},
	returns: v.array(v.object({ description: v.string(), requiresApproval: v.boolean() })),
	handler: async (ctx, { companyId, templateVersionId, selections }) => {
		// Each immutable item is <= 512 KiB; 16 items stay within the 16 MiB read budget.
		if (selections.length > 16) throw new Error('Too many descriptions in one batch.');
		const reader = await snapshotReader(ctx, { companyId, templateVersionId });
		return Promise.all(
			selections.map(async (selection) => {
				const item = await reader.item(selection.itemId);
				const concession = item?.concessions.find((c) => c.id === selection.concessionId);
				if (!item || !concession) throw new Error('This contract snapshot is incomplete.');
				const requiresApproval = Boolean(item.instructions?.changesNeedApproval?.trim());
				if (requiresApproval && (!selection.lifecycle || !selection.reviewStatus))
					throw new Error('This concession is missing review metadata.');
				return { description: concession.description, requiresApproval };
			})
		);
	}
});
