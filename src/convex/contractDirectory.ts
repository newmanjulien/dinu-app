import type { PaginationOptions } from 'convex/server';
import { canonicalJson } from '../lib/document/canonical-json';
import { textPrefix } from '../lib/text';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { liveProfile } from './auth';
import { sellerAuthorName } from './authorPresentation';
import { blockForConnection, installation } from './contractPolicy';
import type { Contract } from './contractState';

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
		templateVersionId: contract.root.templateVersionId,
		companyId: contract.root.companyId,
		creatorId: contract.root.creatorId,
		hubspot: contract.hubspot,
		title: contract.root.title,
		savedAt: contract.root.savedAt,
		hasUnreadComment: options.hasUnreadComment ?? row?.hasUnreadComment ?? false,
		buyerLinkToken: row?.buyerLinkToken,
		buyerLinkCreatorId: row?.buyerLinkCreatorId,
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

/** Discussion writers update the unread priority without changing contract timestamps. */
export async function writeDirectoryUnread(
	ctx: MutationCtx,
	contractId: Id<'savedContracts'>,
	hasUnreadComment: boolean,
	allowMissing = false
) {
	const row = await ctx.db
		.query('contractDirectory')
		.withIndex('by_contractId', (q) => q.eq('contractId', contractId))
		.unique();
	if (!row) {
		if (allowMissing) return;
		throw new Error('The contract directory is missing.');
	}
	if (row.hasUnreadComment !== hasUnreadComment)
		await ctx.db.patch('contractDirectory', row._id, { hasUnreadComment });
}

/** Publishing a link records its token and creator on the contract directory entry. */
export async function markDirectoryBuyerLinkPublished(
	ctx: MutationCtx,
	contractId: Id<'savedContracts'>,
	buyerLinkToken: string,
	buyerLinkCreatorId: Id<'profiles'>
) {
	const row = await ctx.db
		.query('contractDirectory')
		.withIndex('by_contractId', (q) => q.eq('contractId', contractId))
		.unique();
	if (!row) throw new Error('The contract directory is missing.');
	if (row.buyerLinkToken === buyerLinkToken && row.buyerLinkCreatorId === buyerLinkCreatorId)
		return;
	await ctx.db.patch('contractDirectory', row._id, {
		buyerLinkToken,
		buyerLinkCreatorId
	});
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
	const term = textPrefix(search.trim(), 200);
	const [connection, result] = await Promise.all([
		installation(ctx, companyId),
		(term
			? ctx.db
					.query('contractDirectory')
					.withSearchIndex('search_title', (q) =>
						q.search('title', term).eq('companyId', companyId)
					)
			: ctx.db
					.query('contractDirectory')
					.withIndex('by_companyId_and_hasUnreadComment_and_savedAt_and_createdAt', (q) =>
						q.eq('companyId', companyId)
					)
					.order('desc')
		).paginate(paginationOpts)
	]);
	const creators = new Map<Id<'profiles'>, Promise<{ name: string; avatarUrl: string | null }>>();
	function resolveCreator(id: Id<'profiles'>) {
		let creator = creators.get(id);
		if (!creator) {
			creator = (async () => {
				const profile = await liveProfile(ctx, id);
				return {
					name: await sellerAuthorName(ctx, companyId, profile),
					avatarUrl: profile?.avatarId ? await ctx.storage.getUrl(profile.avatarId) : null
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
				templateVersionId: contract.templateVersionId,
				_creationTime: contract.createdAt,
				hubspot: contract.hubspot,
				workBlock: blockForConnection(connection, contract.hubspot),
				title: contract.title,
				savedAt: contract.savedAt,
				hasUnreadComment: contract.hasUnreadComment,
				buyerLinkToken: contract.buyerLinkToken ?? null,
				creator: await resolveCreator(contract.creatorId)
			}))
		)
	};
}
