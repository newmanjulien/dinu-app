import type { PaginationOptions } from 'convex/server';
import { textPrefix } from '../lib/text';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { liveCompanyMember } from './auth';
import { installation, blockForConnection } from './contractPolicy';

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
		hubspot: contract.hubspot,
		buyerCompanyName: contract.buyerCompanyName,
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
	companyId: Id<'company'>,
	search: string,
	paginationOpts: PaginationOptions
) {
	const connection = await installation(ctx, companyId);
	const term = textPrefix(search.trim(), 200);
	const result = await (
		term
			? ctx.db
					.query('contractDirectory')
					.withSearchIndex('search_buyerCompanyName', (q) =>
						q.search('buyerCompanyName', term).eq('companyId', companyId)
					)
			: ctx.db
					.query('contractDirectory')
					.withIndex('by_companyId_and_savedAt_and_createdAt', (q) => q.eq('companyId', companyId))
					.order('desc')
	).paginate(paginationOpts);
	const creators = new Map<Id<'profiles'>, Promise<{ name: string; avatarUrl: string | null }>>();
	function resolveCreator(id: Id<'profiles'>) {
		let creator = creators.get(id);
		if (!creator) {
			creator = (async () => {
				const profile = await liveCompanyMember(ctx, companyId, id);
				if (!profile) return { name: 'Former colleague', avatarUrl: null };
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
				_id: contract.contractId,
				hubspot: contract.hubspot,
				workBlock: blockForConnection(connection, contract.hubspot),
				buyerCompanyName: contract.buyerCompanyName,
				savedAt: contract.savedAt,
				creator: await resolveCreator(contract.creatorId)
			}))
		)
	};
}
