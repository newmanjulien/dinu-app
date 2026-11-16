import { textPrefix } from '../lib/text';
import { markDirectoryBuyerLinkPublished } from './contractDirectory';
import { contextCompletion } from './contractValidators';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { ConvexError, getConvexSize, v } from 'convex/values';
import { query, internalMutation, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { availableCompany, memberForCompany, requireMembership, accessibleContract } from './auth';
import { helpPreferences, profileView } from './accountViews';
import { role } from './permissions';
import {
	currentBuyerDocument,
	linkPreparation,
	linkSummary,
	publicStatus
} from './buyerValidators';
import {
	actionKey,
	receipt,
	remember,
	planReceiptWrite,
	admitOperation
} from './operationReceipts';
import { buyerTokenCollision, isBuyerCode } from '../lib/buyer/token';
import { seller } from './contractState';
import { assertStorageCapacity } from './storageCapacity';
import { currentDocumentMaterialization } from './contractDefinitions';
import { contractReader } from './contractReader';
import { hiddenAnnotations } from './contractAnnotations';
import { materializedBuyerExplanations, buyerAnnotationGroups } from './buyerProjection';
import { contractReadinessState } from './reviews';
import { requireContractWork } from './contractPolicy';
import { currentViewFor, linkFor } from './buyerCurrent';
import { readiness } from '../lib/contract/changes';
export { seller } from './contractState';

const sellerArgs = { membershipId: v.id('memberships'), id: v.id('savedContracts') };
const tokenArgs = { token: v.string() };
function summary(link: Doc<'buyerLinks'>) {
	return { id: link._id, token: link.token, createdAt: link.createdAt };
}
function browseRow(link: Doc<'buyerLinks'>, row: Doc<'contractDirectory'>) {
	return {
		id: link._id,
		contractId: row.contractId,
		token: link.token,
		title: row.title,
		createdAt: link.createdAt,
		hasUnreadComment: row.hasUnreadComment
	};
}
async function linkedDirectoryRow(
	ctx: QueryCtx,
	row: Doc<'contractDirectory'>,
	companyId: Id<'company'>
) {
	const link = await linkFor(ctx, row.contractId);
	return link?.currentView && link.companyId === companyId ? browseRow(link, row) : null;
}
/** Public acquisition depends only on the pointer, immutable content and live gates. */
async function resolveView(ctx: QueryCtx, token: string) {
	if (!isBuyerCode(token)) return null;
	const link = await ctx.db
		.query('buyerLinks')
		.withIndex('by_token', (q) => q.eq('token', token))
		.unique();
	if (!link?.currentView) return null;
	const [company, deletion] = await Promise.all([
		availableCompany(ctx, link.companyId),
		ctx.db
			.query('contractCleanups')
			.withIndex('by_contractId', (q) => q.eq('contractId', link.contractId))
			.unique()
	]);
	return company && !deletion ? { link, view: link.currentView, company } : null;
}
/** Discussion/activity paths additionally require the actual current contract. */
export async function resolveAccess(ctx: QueryCtx, token: string) {
	const found = await resolveView(ctx, token);
	if (!found) return null;
	const contract = await ctx.db.get('savedContracts', found.link.contractId);
	return contract?.companyId === found.link.companyId ? { ...found, contract } : null;
}
export const resolve = resolveAccess;
export const sellerContext = query({
	args: tokenArgs,
	returns: v.union(
		v.null(),
		v.object({
			profile: profileView.omit('avatarUrl'),
			helpPreferences,
			membershipId: v.id('memberships'),
			role,
			contractId: v.id('savedContracts'),
			title: v.string(),
			buyerName: v.union(v.string(), v.null()),
			completion: v.union(contextCompletion, v.null()),
			expectation: readiness.fields.expectation
		})
	),
	handler: async (ctx, { token }) => {
		const found = await resolveAccess(ctx, token);
		if (!found) return null;
		const member = await memberForCompany(ctx, found.link.companyId);
		if (!member) return null;
		return {
			profile: {
				id: member.profile._id,
				name: member.profile.name,
				email: member.profile.email
			},
			helpPreferences: member.profile.helpPreferences,
			membershipId: member.membership._id,
			role: member.membership.role,
			contractId: found.contract._id,
			title: found.view.title,
			buyerName: found.view.buyerName,
			completion: found.contract.reviews.buyerLink.completion ?? null,
			expectation: {
				stateRevision: found.contract.stateRevision,
				documentId: found.view.documentId,
				documentRevision: found.view.documentRevision
			}
		};
	}
});
export const latest = query({
	args: sellerArgs,
	returns: v.union(linkSummary, v.null()),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		const root = accessibleContract(await ctx.db.get('savedContracts', args.id), access);
		if (!root) throw new ConvexError('This contract is unavailable.');
		const link = await linkFor(ctx, root._id);
		return link?.currentView ? summary(link) : null;
	}
});
export const dashboardPresence = query({
	args: { membershipId: v.id('memberships') },
	returns: v.object({
		hasActive: v.union(v.boolean(), v.null()),
		hasCreatedOneLink: v.boolean()
	}),
	handler: async (ctx, { membershipId }) => {
		const access = await requireMembership(ctx, membershipId);
		const [row, ownLinks] = await Promise.all([
			ctx.db
				.query('contractDirectory')
				.withIndex('by_companyId_hasBuyerLink_hasUnreadComment_buyerLinkCreatedAt', (q) =>
					q.eq('companyId', access.companyId).eq('hasBuyerLink', true)
				)
				.first(),
			ctx.db
				.query('buyerLinks')
				.withIndex('by_companyId_and_creatorId', (q) =>
					q.eq('companyId', access.companyId).eq('creatorId', access.profile._id)
				)
				.take(2)
		]);
		const hasCreatedOneLink = ownLinks.length === 1 && ownLinks[0].currentView !== null;
		if (row) return { hasActive: true, hasCreatedOneLink };
		// Missing flags cannot prove absence until every existing row has been backfilled.
		const backfilled = await ctx.db
			.query('buyerLinkBrowseBackfills')
			.withIndex('by_key', (q) => q.eq('key', 'directory'))
			.unique();
		return { hasActive: backfilled ? false : null, hasCreatedOneLink };
	}
});
export const browse = query({
	args: {
		membershipId: v.id('memberships'),
		search: v.optional(v.string()),
		paginationOpts: paginationOptsValidator
	},
	returns: paginationResultValidator(
		v.object({
			id: v.id('buyerLinks'),
			contractId: v.id('savedContracts'),
			token: v.string(),
			title: v.string(),
			createdAt: v.number(),
			hasUnreadComment: v.boolean()
		})
	),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		const backfilled = await ctx.db
			.query('buyerLinkBrowseBackfills')
			.withIndex('by_key', (q) => q.eq('key', 'directory'))
			.unique();
		const term = textPrefix((args.search ?? '').trim(), 200);
		if (term) {
			const result = await ctx.db
				.query('contractDirectory')
				.withSearchIndex('search_title', (q) => {
					const scoped = q.search('title', term).eq('companyId', access.companyId);
					return backfilled ? scoped.eq('hasBuyerLink', true) : scoped;
				})
				.paginate(args.paginationOpts);
			const rows = await Promise.all(
				result.page.map((row) => linkedDirectoryRow(ctx, row, access.companyId))
			);
			return { ...result, page: rows.filter((row) => row !== null) };
		}
		if (!backfilled) {
			const result = await ctx.db
				.query('buyerLinks')
				.withIndex('by_companyId', (q) => q.eq('companyId', access.companyId))
				.order('desc')
				.paginate(args.paginationOpts);
			const rows = await Promise.all(
				result.page.map(async (link) => {
					if (!link.currentView) return null;
					const row = await ctx.db
						.query('contractDirectory')
						.withIndex('by_contractId', (q) => q.eq('contractId', link.contractId))
						.unique();
					return row?.companyId === access.companyId ? browseRow(link, row) : null;
				})
			);
			return { ...result, page: rows.filter((row) => row !== null) };
		}
		// The index keeps unread links ahead of read links across page boundaries.
		const result = await ctx.db
			.query('contractDirectory')
			.withIndex('by_companyId_hasBuyerLink_hasUnreadComment_buyerLinkCreatedAt', (q) =>
				q.eq('companyId', access.companyId).eq('hasBuyerLink', true)
			)
			.order('desc')
			.paginate(args.paginationOpts);
		const rows = await Promise.all(
			result.page.map((row) => linkedDirectoryRow(ctx, row, access.companyId))
		);
		return { ...result, page: rows.filter((row) => row !== null) };
	}
});
/** Crypto remains in the action; native readiness + pointer creation is one transaction. */
export const capture = internalMutation({
	args: { ...sellerArgs, preparation: linkPreparation, token: v.string() },
	returns: linkSummary,
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		const root = accessibleContract(await ctx.db.get('savedContracts', args.id), access);
		if (!root) throw new ConvexError('This contract is unavailable.');
		const preparation = args.preparation;
		if (preparation.kind === 'prepared') admitOperation(preparation.operationId);
		const key =
			preparation.kind === 'prepared'
				? actionKey(access, 'first-link', preparation.operationId)
				: null;
		const inputs =
			preparation.kind === 'prepared'
				? JSON.stringify([args.id, preparation.expectedState, 'buyer-link'])
				: '';
		const prior = key ? await receipt(ctx, key, inputs) : null;
		if (prior) {
			if (
				prior.state !== 'complete' ||
				prior.companyId !== access.companyId ||
				prior.contractId !== args.id
			)
				throw new ConvexError('This link request is unavailable.');
			const link = await linkFor(ctx, args.id);
			if (!link?.currentView) throw new ConvexError('This link is unavailable.');
			return summary(link);
		}
		const existing = await linkFor(ctx, args.id);
		if (existing?.currentView) return summary(existing);
		if (existing || preparation.kind !== 'prepared' || !key)
			throw new ConvexError(
				'Prepare the current approved contract before creating its first link.'
			);
		const { contract } = await seller(ctx, args);
		await requireContractWork(ctx, contract);
		const expected = preparation.expectedState;
		if (
			root.stateRevision !== expected.stateRevision ||
			root.documentId !== expected.documentId ||
			root.documentRevision !== expected.documentRevision
		)
			throw new ConvexError(
				'The saved contract changed. Review the current contract and try again.'
			);
		const source = await contractReadinessState(ctx, contract);
		if (!source.ready)
			throw new ConvexError('Approve or withdraw the current required changes before continuing.');
		if (!isBuyerCode(args.token)) throw new ConvexError('Invalid link request.');
		if (
			await ctx.db
				.query('buyerLinks')
				.withIndex('by_token', (q) => q.eq('token', args.token))
				.unique()
		)
			throw new ConvexError(buyerTokenCollision);
		const manifest = await ctx.db.get('contractDocuments', contract.root.documentId);
		if (!manifest || manifest.companyId !== access.companyId || manifest.contractId !== args.id)
			throw new Error('Invalid current document ownership.');
		const value = {
			companyId: access.companyId,
			contractId: args.id,
			creatorId: access.profile._id,
			token: args.token,
			createdAt: Date.now(),
			currentView: currentViewFor(contract.root, manifest.fingerprint)
		};
		const receiptPlan = planReceiptWrite(
			access.companyId,
			key,
			inputs,
			JSON.stringify({ id: 'x'.repeat(32), token: value.token, createdAt: value.createdAt }),
			{ contractId: args.id }
		);
		await assertStorageCapacity(ctx, {
			documents: 1 + receiptPlan.work.documents,
			bytes: getConvexSize(value) + 128 + receiptPlan.work.bytes
		});
		const id = await ctx.db.insert('buyerLinks', value);
		await markDirectoryBuyerLinkPublished(ctx, args.id, value.createdAt);
		const result = { id, token: value.token, createdAt: value.createdAt };
		await remember(ctx, access.companyId, key, inputs, JSON.stringify(result), {
			contractId: args.id
		});
		return result;
	}
});
export const status = query({
	args: tokenArgs,
	returns: publicStatus,
	handler: async (ctx, { token }) => {
		const found = await resolveView(ctx, token);
		return found
			? {
					kind: 'current' as const,
					title: found.view.title,
					companyName: found.company.name,
					buyerName: found.view.buyerName
				}
			: { kind: 'unavailable' as const };
	}
});
/** One current link snapshot and verified audience for the first page title. */
export const pageContext = query({
	args: tokenArgs,
	returns: v.union(
		v.object({ kind: v.literal('unavailable') }),
		v.object({ kind: v.literal('account-error') }),
		v.object({
			kind: v.literal('current'),
			audience: v.union(v.literal('buyer'), v.literal('seller')),
			buyerName: v.union(v.string(), v.null())
		})
	),
	handler: async (ctx, { token }) => {
		const found = await resolveView(ctx, token);
		if (!found) return { kind: 'unavailable' as const };
		let member: Awaited<ReturnType<typeof memberForCompany>>;
		try {
			member = await memberForCompany(ctx, found.link.companyId);
		} catch (error) {
			if (error instanceof ConvexError) return { kind: 'account-error' as const };
			throw error;
		}
		// Seller presentation also requires the live contract, as sellerContext does.
		const contract = member ? await ctx.db.get('savedContracts', found.link.contractId) : null;
		return {
			kind: 'current' as const,
			audience:
				member && contract?.companyId === found.link.companyId
					? ('seller' as const)
					: ('buyer' as const),
			buyerName: found.view.buyerName
		};
	}
});
export const currentDocument = query({
	args: tokenArgs,
	returns: currentBuyerDocument,
	handler: async (ctx, { token }) => {
		const found = await resolveView(ctx, token);
		if (!found) throw new ConvexError('This link is unavailable.');
		const root = { _id: found.link.contractId, companyId: found.link.companyId, ...found.view };
		const current = await currentDocumentMaterialization(ctx, { root }, found.view);
		if (current.displayIdentity !== found.view.displayIdentity)
			throw new Error('Invalid published display identity.');
		const reader = await contractReader(ctx, root);
		const hidden = new Set(await hiddenAnnotations(ctx, { root }, current.document, reader));
		const explanations = materializedBuyerExplanations(
			(await reader.buyerExplanations()).filter((item) => !hidden.has(item._id)),
			current.document
		);
		const result = {
			title: found.view.title,
			document: current.transport,
			contentIdentity: found.view.documentId,
			contentRevision: found.view.documentRevision,
			displayIdentity: found.view.displayIdentity,
			explanations,
			annotationGroups: buyerAnnotationGroups(current.document)
		};
		if (getConvexSize(result) > 15_000_000)
			throw new ConvexError('This contract exceeds supported response capacity.');
		return result;
	}
});
export const authorizeDownload = query({
	args: { token: v.string(), displayIdentity: v.string() },
	returns: v.null(),
	handler: async (ctx, { token, displayIdentity }) => {
		const found = await resolveView(ctx, token);
		if (!found || found.view.displayIdentity !== displayIdentity)
			throw new ConvexError(
				'The displayed contract changed. Review the current contract and try again.'
			);
		return null;
	}
});
