import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { EmailSelection } from './emailValidators';
import { chunkEntries, CHUNK_READ_LIMIT } from './chunks';

export async function storeSelections(
	ctx: MutationCtx,
	companyId: Id<'company'>,
	deliveryId: Id<'emailDeliveries'>,
	entries: EmailSelection[]
) {
	const groups = chunkEntries(
		entries,
		(selections) => ({ companyId, deliveryId, order: 0, selections }),
		'Email snapshot entry is too large.'
	);
	if (groups.length >= CHUNK_READ_LIMIT) throw new Error('Email snapshot exceeds its bounds.');
	for (const [order, selections] of groups.entries())
		await ctx.db.insert('emailSnapshots', { companyId, deliveryId, order, selections });
}
export async function selectionsFor(ctx: QueryCtx, deliveryId: Id<'emailDeliveries'>) {
	const rows = await ctx.db
		.query('emailSnapshots')
		.withIndex('by_deliveryId_and_order', (q) => q.eq('deliveryId', deliveryId))
		.take(CHUNK_READ_LIMIT);
	if (rows.length === CHUNK_READ_LIMIT) throw new Error('Email snapshot exceeds its bounds.');
	return rows.flatMap((row) => row.selections);
}
