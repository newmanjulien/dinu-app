import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';

/** Read ownership inside the same transaction as deletion, including staged uploads. */
export async function documentFileOwned(ctx: QueryCtx, fileId: Id<'_storage'>) {
	const [baseline, attachment] = await Promise.all([
		ctx.db
			.query('baselines')
			.withIndex('by_originalFileId', (q) => q.eq('originalFileId', fileId))
			.first(),
		ctx.db
			.query('delegationAttachments')
			.withIndex('by_storageId', (q) => q.eq('storageId', fileId))
			.first()
	]);
	return !!(baseline || attachment);
}
