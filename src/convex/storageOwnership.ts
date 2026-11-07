import { v } from 'convex/values';
import { internalMutation, type QueryCtx, type MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';

const ORPHAN_GRACE = 24 * 60 * 60_000;

/** Read ownership inside the same transaction as deletion, including staged uploads. */
export async function fileOwned(ctx: QueryCtx, fileId: Id<'_storage'>) {
	const [baseline, profile, company, exportAttempt] = await Promise.all([
		ctx.db
			.query('baselines')
			.withIndex('by_originalFileId', (q) => q.eq('originalFileId', fileId))
			.first(),
		ctx.db
			.query('profiles')
			.withIndex('by_avatarId', (q) => q.eq('avatarId', fileId))
			.first(),
		ctx.db
			.query('company')
			.withIndex('by_avatarId', (q) => q.eq('avatarId', fileId))
			.first(),
		ctx.db
			.query('hubspotExports')
			.withIndex('by_fileId', (q) => q.eq('fileId', fileId))
			.first()
	]);
	return !!(baseline || profile || company || exportAttempt);
}

/** Release the owner's reference first, then check all owners in this transaction. */
export async function deleteUnownedFile(ctx: MutationCtx, fileId: Id<'_storage'>) {
	if (!(await fileOwned(ctx, fileId))) await ctx.storage.delete(fileId);
}

// Action failure does not prove a committing mutation failed. Preserve adopted bytes.
export const discardFile = internalMutation({
	args: { fileId: v.id('_storage') },
	returns: v.null(),
	handler: async (ctx, { fileId }) => {
		await deleteUnownedFile(ctx, fileId);
		return null;
	}
});

// Recover interrupted uploads/exports once per creation interval. Referenced files
// are subsequently deleted by their owner lifecycle, not rescanned here.
export const cleanOrphanFiles = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())), cutoff: v.optional(v.number()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const sweep = await ctx.db
			.query('fileSweeps')
			.withIndex('by_kind', (q) => q.eq('kind', 'storage-orphans'))
			.unique();
		// A duplicate continuation must not advance a newer page or interval.
		if (
			args.cutoff !== undefined &&
			(sweep?.active?.cutoff !== args.cutoff || sweep.active.cursor !== (args.cursor ?? null))
		)
			return null;
		const cutoff = sweep?.active?.cutoff ?? Date.now() - ORPHAN_GRACE;
		const completedThrough = sweep?.completedThrough ?? null;
		if (completedThrough !== null && cutoff <= completedThrough) return null;
		const sweepId =
			sweep?._id ??
			(await ctx.db.insert('fileSweeps', {
				kind: 'storage-orphans',
				completedThrough: null,
				active: { cutoff, cursor: null }
			}));
		const result = await ctx.db.system
			.query('_storage')
			.withIndex('by_creation_time', (q) =>
				completedThrough === null
					? q.lte('_creationTime', cutoff)
					: q.gt('_creationTime', completedThrough).lte('_creationTime', cutoff)
			)
			.paginate({
				cursor: sweep?.active?.cursor ?? null,
				numItems: 25,
				maximumRowsRead: 25,
				maximumBytesRead: 1024 * 1024
			});
		for (const file of result.page) await deleteUnownedFile(ctx, file._id);
		await ctx.db.patch(
			'fileSweeps',
			sweepId,
			result.isDone
				? { completedThrough: cutoff, active: null }
				: { active: { cutoff, cursor: result.continueCursor } }
		);
		if (!result.isDone)
			await ctx.scheduler.runAfter(0, internal.storageOwnership.cleanOrphanFiles, {
				cursor: result.continueCursor,
				cutoff
			});
		return null;
	}
});
