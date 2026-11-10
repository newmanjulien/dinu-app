import { buyerItem, buyerExplanation, publicProjection } from './buyerProjection';
import { releasedRecord } from '../lib/contract/released-selections';
import { getConvexSize } from 'convex/values';
import { requireTerminologyReady } from './terminologyMaintenance';
import { ConvexError, v } from 'convex/values';
import { query, mutation, internalMutation, type QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { accessibleContract, availableCompany, requireMembership } from './auth';
import { requireContractWork } from './contractPolicy';
import { contractReader } from './contractReader';
import { buyerContent, linkPreparation, linkSummary, publicStatus } from './buyerValidators';
import { buyerTokenCollision, isBuyerCode } from '../lib/buyer/token';
import { acknowledgmentFor, linkFor, publicationFor } from './contractPublication';
import { assertStorageCapacity, documentBytes } from './storageCapacity';

const sellerArgs = { membershipId: v.id('memberships'), id: v.id('savedContracts') };
const tokenArgs = { token: v.string() };
function summary(link: Doc<'buyerLinks'>) {
	return { id: link._id, token: link.token, createdAt: link.createdAt };
}
export async function seller(
	ctx: QueryCtx,
	args: { membershipId: Doc<'memberships'>['_id']; id: Doc<'savedContracts'>['_id'] }
) {
	const access = await requireMembership(ctx, args.membershipId);
	const contract = accessibleContract(await ctx.db.get('savedContracts', args.id), access);
	if (!contract) throw new ConvexError('This contract is unavailable.');
	return { access, contract };
}
export async function contractAccess(ctx: QueryCtx, id: Doc<'savedContracts'>['_id']) {
	const row = await ctx.db
		.query('contractAccess')
		.withIndex('by_contractId', (q) => q.eq('contractId', id))
		.unique();
	return row
		? { _id: row.contractId, companyId: row.companyId, templateVersionId: row.templateVersionId }
		: null;
}
export async function resolveAccess(ctx: QueryCtx, token: string) {
	requireTerminologyReady();
	if (!isBuyerCode(token)) return null;
	const link = await ctx.db
		.query('buyerLinks')
		.withIndex('by_token', (q) => q.eq('token', token))
		.unique();
	if (!link) return null;
	const [contract, company] = await Promise.all([
		contractAccess(ctx, link.contractId),
		availableCompany(ctx, link.companyId)
	]);
	if (!contract || contract.companyId !== link.companyId || !company) return null;
	return { link, contract };
}
export async function resolve(ctx: QueryCtx, token: string) {
	const found = await resolveAccess(ctx, token);
	if (!found) return null;
	const state = await publicationFor(ctx, found.contract._id);
	return state &&
		state.companyId === found.contract.companyId &&
		state.templateVersionId === found.contract.templateVersionId
		? { ...found, state }
		: null;
}
export const latest = query({
	args: sellerArgs,
	returns: v.union(linkSummary, v.null()),
	handler: async (ctx, args) => {
		const { contract } = await seller(ctx, args);
		await requireContractWork(ctx, contract);
		const link = await linkFor(ctx, contract._id);
		return link ? summary(link) : null;
	}
});
export const warning = query({
	args: sellerArgs,
	returns: v.object({ published: v.boolean(), acknowledged: v.boolean() }),
	handler: async (ctx, args) => {
		const { contract, access } = await seller(ctx, args);
		return {
			published: Boolean(await linkFor(ctx, contract._id)),
			acknowledged: Boolean(await acknowledgmentFor(ctx, contract._id, access.profile._id))
		};
	}
});
export const acknowledge = mutation({
	args: sellerArgs,
	returns: v.null(),
	handler: async (ctx, args) => {
		const { contract, access } = await seller(ctx, args);
		if (access.membership.role !== 'admin')
			throw new ConvexError('Only company admins can acknowledge publication.');
		if (
			(await linkFor(ctx, contract._id)) &&
			!(await acknowledgmentFor(ctx, contract._id, access.profile._id))
		) {
			await assertStorageCapacity(ctx, { documents: 1, bytes: 2000 });
			await ctx.db.insert('publicationAcknowledgments', {
				companyId: contract.companyId,
				contractId: contract._id,
				profileId: access.profile._id
			});
		}
		return null;
	}
});
export const capture = internalMutation({
	args: {
		...sellerArgs,
		preparation: linkPreparation,
		token: v.string()
	},
	returns: linkSummary,
	handler: async (ctx, args) => {
		const { access, contract } = await seller(ctx, args);
		await requireContractWork(ctx, contract);
		const existing = await linkFor(ctx, contract._id);
		if (existing) return summary(existing);
		if (!isBuyerCode(args.token)) throw new ConvexError('Invalid link request.');
		if (
			args.preparation.kind === 'flushed' &&
			contract.editRevision !== args.preparation.expectedEditRevision
		)
			throw new ConvexError('This contract changed. Refresh and try again.');
		if (
			await ctx.db
				.query('buyerLinks')
				.withIndex('by_token', (q) => q.eq('token', args.token))
				.unique()
		)
			throw new ConvexError(buyerTokenCollision);
		const state = await publicationFor(ctx, contract._id);
		if (!state) throw new ConvexError('This contract publication is unavailable.');
		// Admit the immutable opening payload once, leaving 4 MB for every future
		// released projection and ample room below the 16 MiB response boundary.
		const reader = await contractReader(ctx, contract);
		const [blocks, template, selected, explanations] = await Promise.all([
			reader.blocks(),
			reader.templateItems(),
			reader.releasedItems(releasedRecord(state.selections)),
			reader.buyerExplanations()
		]);
		if (
			getConvexSize({
				blocks,
				templateItems: template.map((item) => buyerItem(item)),
				explanations: explanations.map(buyerExplanation)
			}) > 10_000_000
		)
			throw new ConvexError('This publication exceeds supported response capacity.');
		publicProjection(state, selected);
		reader.validatePublicationRead(selected, documentBytes(state));
		await assertStorageCapacity(ctx, { documents: 1, bytes: 2000 });
		const record = {
			companyId: contract.companyId,
			contractId: contract._id,
			creatorId: access.profile._id,
			token: args.token,
			createdAt: Date.now()
		};
		const id = await ctx.db.insert('buyerLinks', record);
		return { id, token: record.token, createdAt: record.createdAt };
	}
});
export const status = query({
	args: tokenArgs,
	returns: publicStatus,
	handler: async (ctx, { token }) => {
		const result = await resolve(ctx, token);
		return result
			? {
					kind: 'current' as const,
					title: result.state.title,
					buyerRevision: result.state.buyerRevision
				}
			: { kind: 'unavailable' as const };
	}
});
export const content = query({
	args: tokenArgs,
	returns: buyerContent,
	handler: async (ctx, { token }) => {
		const result = await resolve(ctx, token);
		if (!result) throw new ConvexError('This link is unavailable.');
		const { state, contract } = result;
		const reader = await contractReader(ctx, contract);
		const [blocks, selected, template, explanations] = await Promise.all([
			reader.blocks(),
			reader.releasedItems(releasedRecord(state.selections)),
			reader.templateItems(),
			reader.buyerExplanations()
		]);
		const payload = {
			...publicProjection(state, selected),
			blocks,
			templateItems: template.map((item) => buyerItem(item)),
			explanations: explanations.map(buyerExplanation)
		};
		if (getConvexSize(payload) > 15_000_000)
			throw new ConvexError('This publication exceeds supported response capacity.');
		return payload;
	}
});
export const authorizeDownload = query({
	args: { ...tokenArgs, buyerRevision: v.number() },
	returns: v.null(),
	handler: async (ctx, { token, buyerRevision }) => {
		const result = await resolve(ctx, token);
		if (!result || result.state.buyerRevision !== buyerRevision)
			throw new ConvexError('This contract changed. Download its current version.');
		return null;
	}
});

/** Mutable public projection; immutable template blocks are loaded only when opening. */
export const publication = query({
	args: tokenArgs,
	returns: buyerContent.omit('blocks', 'templateItems', 'explanations'),
	handler: async (ctx, { token }) => {
		const result = await resolve(ctx, token);
		if (!result) throw new ConvexError('This link is unavailable.');
		const items = await (
			await contractReader(ctx, result.contract)
		).releasedItems(releasedRecord(result.state.selections));
		return publicProjection(result.state, items);
	}
});
