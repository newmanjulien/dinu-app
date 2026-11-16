import type { Contract } from './contractState';
import { paginationOptsValidator, type PaginationOptions } from 'convex/server';
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { assertStorageCapacity, documentBytes } from './storageCapacity';
import { textPrefix } from '../lib/text';
import { canonicalJson } from '../lib/document/canonical-json';
import type { Id, Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { liveProfile } from './auth';
import { sellerAuthorName } from './authorPresentation';
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
		hasBuyerLink: row?.hasBuyerLink ?? false,
		buyerLinkCreatedAt: row?.buyerLinkCreatedAt,
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

/** Discussion writers update the unread priority without changing link creation time. */
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

/** Publishing a link records its creation time for the buyer links list. */
export async function markDirectoryBuyerLinkPublished(
	ctx: MutationCtx,
	contractId: Id<'savedContracts'>,
	buyerLinkCreatedAt: number
) {
	const row = await ctx.db
		.query('contractDirectory')
		.withIndex('by_contractId', (q) => q.eq('contractId', contractId))
		.unique();
	if (!row) throw new Error('The contract directory is missing.');
	if (row.hasBuyerLink === true && row.buyerLinkCreatedAt === buyerLinkCreatedAt) return;
	await assertStorageCapacity(ctx, {
		documents: 1,
		bytes: documentBytes({ ...row, hasBuyerLink: true, buyerLinkCreatedAt })
	});
	await ctx.db.patch('contractDirectory', row._id, { hasBuyerLink: true, buyerLinkCreatedAt });
}

/** Rollout: publish the completion marker only after every directory row is backfilled. */
export const backfillBuyerLinks = internalMutation({
	args: { paginationOpts: paginationOptsValidator },
	returns: v.object({
		continueCursor: v.string(),
		isDone: v.boolean(),
		scanned: v.number(),
		changed: v.number()
	}),
	handler: async (ctx, { paginationOpts }) => {
		if (paginationOpts.numItems > 100) throw new Error('Backfill at most 100 rows at a time.');
		if (paginationOpts.endCursor !== undefined && paginationOpts.endCursor !== null)
			throw new Error('Backfill with continuation cursors, not explicit end ranges.');
		const result = await ctx.db.query('contractDirectory').paginate(paginationOpts);
		let changed = 0;
		for (const row of result.page) {
			const link = await ctx.db
				.query('buyerLinks')
				.withIndex('by_contractId', (q) => q.eq('contractId', row.contractId))
				.unique();
			const hasBuyerLink = Boolean(link?.currentView && link.companyId === row.companyId);
			const buyerLinkCreatedAt = hasBuyerLink ? link!.createdAt : undefined;
			if (row.hasBuyerLink !== hasBuyerLink || row.buyerLinkCreatedAt !== buyerLinkCreatedAt) {
				await ctx.db.patch('contractDirectory', row._id, {
					hasBuyerLink,
					buyerLinkCreatedAt
				});
				changed++;
			}
		}
		if (result.isDone) {
			const completed = await ctx.db
				.query('buyerLinkBrowseBackfills')
				.withIndex('by_key', (q) => q.eq('key', 'directory'))
				.unique();
			if (!completed)
				await ctx.db.insert('buyerLinkBrowseBackfills', {
					key: 'directory',
					completedAt: Date.now()
				});
		}
		return {
			continueCursor: result.continueCursor,
			isDone: result.isDone,
			scanned: result.page.length,
			changed
		};
	}
});

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
