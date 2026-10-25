import type { PaginationOptions } from 'convex/server';
import { v } from 'convex/values';
import { internalMutation, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { companyDeletion, liveProfile } from './auth';

/** Update in the same transaction as every contract metadata write. */
export async function writeDirectory(ctx: MutationCtx, contract: Doc<'savedContracts'>) {
	const row = await ctx.db
		.query('contractDirectory')
		.withIndex('by_contractId', (q) => q.eq('contractId', contract._id))
		.unique();
	const value = {
		contractId: contract._id,
		companyId: contract.companyId,
		creatorId: contract.creatorId,
		companyName: contract.companyName,
		savedAt: contract.savedAt,
		createdAt: contract._creationTime
	};
	if (!row) await ctx.db.insert('contractDirectory', value);
	else if (Object.entries(value).some(([key, value]) => row[key as keyof typeof row] !== value))
		await ctx.db.replace('contractDirectory', row._id, value);
}

export async function removeDirectoryEntry(ctx: MutationCtx, id: Id<'savedContracts'>) {
	const row = await ctx.db
		.query('contractDirectory')
		.withIndex('by_contractId', (q) => q.eq('contractId', id))
		.unique();
	if (row) await ctx.db.delete('contractDirectory', row._id);
}

/** Caller must first verify access to this company. */
export async function readDirectory(
	ctx: QueryCtx,
	company: Pick<Doc<'company'>, '_id' | 'contractDirectoryReady'>,
	search: string,
	paginationOpts: PaginationOptions,
	useDirectory = Boolean(company.contractDirectoryReady)
) {
	const term = search.trim().slice(0, 200);
	// Keep all existing contracts visible until the bounded backfill completes.
	const result =
		company.contractDirectoryReady && useDirectory
			? await (
					term
						? ctx.db
								.query('contractDirectory')
								.withSearchIndex('search_companyName', (q) =>
									q.search('companyName', term).eq('companyId', company._id)
								)
						: ctx.db
								.query('contractDirectory')
								.withIndex('by_companyId_and_savedAt_and_createdAt', (q) =>
									q.eq('companyId', company._id)
								)
								.order('desc')
				).paginate(paginationOpts)
			: await (
					term
						? ctx.db
								.query('savedContracts')
								.withSearchIndex('search_companyName', (q) =>
									q.search('companyName', term).eq('companyId', company._id)
								)
						: ctx.db
								.query('savedContracts')
								.withIndex('by_companyId_and_savedAt', (q) => q.eq('companyId', company._id))
								.order('desc')
				).paginate(paginationOpts);
	const creators = new Map<Id<'profiles'>, Promise<{ name: string; avatarUrl: string | null }>>();
	function resolveCreator(id: Id<'profiles'>) {
		let creator = creators.get(id);
		if (!creator) {
			creator = (async () => {
				const profile = await liveProfile(ctx, id);
				if (!profile) return { name: 'Former colleague', avatarUrl: null };
				const member = await ctx.db
					.query('memberships')
					.withIndex('by_profileId', (q) => q.eq('profileId', profile._id))
					.unique();
				if (member?.companyId !== company._id) return { name: 'Former colleague', avatarUrl: null };
				return {
					name: profile.name || profile.email || 'Colleague',
					avatarUrl: profile.avatarId ? await ctx.storage.getUrl(profile.avatarId) : null
				};
			})();
			creators.set(id, creator);
		}
		return creator;
	}
	return {
		...result,
		page: await Promise.all(
			result.page.map(async (contract) => ({
				_id: 'contractId' in contract ? contract.contractId : contract._id,
				companyName: contract.companyName,
				savedAt: contract.savedAt,
				creator: await resolveCreator(contract.creatorId)
			}))
		)
	};
}

/** Safe to restart; concurrent creates, edits and deletes maintain the same directory. */
export const backfill = internalMutation({
	args: { companyId: v.id('company'), cursor: v.optional(v.union(v.string(), v.null())) },
	returns: v.null(),
	handler: async (ctx, { companyId, cursor }) => {
		const company = await ctx.db.get('company', companyId);
		if (!company || company.contractDirectoryReady) return null;
		const deletion = await companyDeletion(ctx, companyId);
		if (deletion) {
			// Preparation and dispatch can be cancelled. Keep the same cursor until the hold ends.
			if (deletion.status === 'prepared' || deletion.status === 'dispatched')
				await ctx.scheduler.runAfter(60_000, internal.contractDirectory.backfill, {
					companyId,
					cursor
				});
			return null;
		}
		const result = await ctx.db
			.query('savedContracts')
			.withIndex('by_companyId_and_savedAt', (q) => q.eq('companyId', companyId))
			.paginate({ cursor: cursor ?? null, numItems: 8 });
		for (const contract of result.page) await writeDirectory(ctx, contract);
		if (result.isDone) await ctx.db.patch('company', companyId, { contractDirectoryReady: true });
		else
			await ctx.scheduler.runAfter(0, internal.contractDirectory.backfill, {
				companyId,
				cursor: result.continueCursor
			});
		return null;
	}
});

export const backfillAll = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	returns: v.null(),
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db
			.query('company')
			.withIndex('by_creation_time')
			.paginate({ cursor: cursor ?? null, numItems: 25 });
		for (const company of result.page)
			if (!company.contractDirectoryReady)
				await ctx.scheduler.runAfter(0, internal.contractDirectory.backfill, {
					companyId: company._id
				});
		if (!result.isDone)
			await ctx.scheduler.runAfter(0, internal.contractDirectory.backfillAll, {
				cursor: result.continueCursor
			});
		return null;
	}
});
