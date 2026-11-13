import type { Contract } from './contractState';
import type { PaginationOptions } from 'convex/server';
import { textPrefix } from '../lib/text';
import { canonicalJson } from '../lib/document/canonical-json';
import type { Id, Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { liveCompanyMember } from './auth';
import { installation, blockForConnection } from './contractPolicy';

/** Update in the same transaction as every contract metadata write. */
export async function writeDirectory(
	ctx: MutationCtx,
	contract: Contract,
	options: { hasUnreadComment?: boolean; directoryRow?: Doc<'contractDirectory'> } = {}
) {
	const row =
		options.directoryRow ??
		(await ctx.db
			.query('contractDirectory')
			.withIndex('by_contractId', (q) => q.eq('contractId', contract.root._id))
			.unique());
	const value = {
		contractId: contract.root._id,
		companyId: contract.root.companyId,
		creatorId: contract.root.creatorId,
		hubspot: contract.hubspot,
		title: contract.root.title,
		savedAt: contract.root.savedAt,
		hasUnreadComment: options.hasUnreadComment ?? row?.hasUnreadComment ?? false,
		createdAt: contract.root._creationTime
	};
	if (!row) await ctx.db.insert('contractDirectory', value);
	else if (
		Object.entries(value).some(
			([key, value]) =>
				canonicalJson(row[key as keyof typeof row] ?? null) !== canonicalJson(value ?? null)
		)
	)
		await ctx.db.replace('contractDirectory', row._id, value);
}

/** Discussion writers change only the stable Boolean, never listing order. */
export async function writeDirectoryUnread(
	ctx: MutationCtx,
	contractId: Id<'savedContracts'>,
	hasUnreadComment: boolean
) {
	const row = await ctx.db
		.query('contractDirectory')
		.withIndex('by_contractId', (q) => q.eq('contractId', contractId))
		.unique();
	if (!row) throw new Error('The contract directory is missing.');
	if (row.hasUnreadComment !== hasUnreadComment)
		await ctx.db.patch('contractDirectory', row._id, { hasUnreadComment });
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
					.withSearchIndex('search_title', (q) =>
						q.search('title', term).eq('companyId', companyId)
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
				_creationTime: contract.createdAt,
				hubspot: contract.hubspot,
				workBlock: blockForConnection(connection, contract.hubspot),
				title: contract.title,
				savedAt: contract.savedAt,
				hasUnreadComment: contract.hasUnreadComment,
				creator: await resolveCreator(contract.creatorId)
			}))
		)
	};
}
