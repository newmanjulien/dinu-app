import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ConvexError, getConvexSize, v, type Infer } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
	action,
	internalMutation,
	query,
	env,
	type MutationCtx,
	type QueryCtx
} from './_generated/server';
import {
	buyerCodeAlphabet,
	buyerCodeLength,
	buyerTokenCollision,
	isBuyerCode
} from '../lib/buyer/token';
import { approvedConcessionMap, contractReadiness } from '../lib/contract/changes';
import { availableCompany, memberForCompany } from './auth';
import {
	buyerDocumentState,
	buyerDownloadSnapshot,
	buyerTemplateContent,
	linkCapture
} from './buyerValidators';
import { buyerName } from './contractBuyer';
import { markDirectoryBuyerLinkPublished } from './contractDirectory';
import { requireContractWork } from './contractPolicy';
import { seller } from './contractState';
import { deleteAffectedComments, type PreloadedInvalidation } from './discussionInvalidation';
import { actionKey, receipt, remember, validateOperationId } from './operationReceipts';
import { readAppliedOverlays, versionReader } from './templates';

export { seller } from './contractState';

const sellerArgs = { membershipId: v.id('memberships'), id: v.id('savedContracts') };
const tokenArgs = { token: v.string() };

function summary(link: Doc<'buyerLinks'>) {
	return { id: link._id, token: link.token, createdAt: link.createdAt };
}

type LiveBuyerLink = Doc<'buyerLinks'> & {
	currentView: NonNullable<Doc<'buyerLinks'>['currentView']>;
};

export function linkFor(ctx: QueryCtx, contractId: Id<'savedContracts'>) {
	return ctx.db
		.query('buyerLinks')
		.withIndex('by_contractId', (q) => q.eq('contractId', contractId))
		.unique();
}

export async function liveLinkFor(
	ctx: QueryCtx,
	contractId: Id<'savedContracts'>
): Promise<LiveBuyerLink | null> {
	const link = await linkFor(ctx, contractId);
	return link && link.currentView !== null ? { ...link, currentView: link.currentView } : null;
}

export async function hasActiveLinkForCreator(
	ctx: QueryCtx,
	companyId: Id<'company'>,
	creatorId: Id<'profiles'>
) {
	const row = await ctx.db
		.query('contractDirectory')
		.withIndex('by_companyId_and_buyerLinkCreatorId', (q) =>
			q.eq('companyId', companyId).eq('buyerLinkCreatorId', creatorId)
		)
		.first();
	return row !== null;
}

export function displayIdentityFor(
	templateVersionId: Id<'templateVersions'>,
	concessions: Readonly<Record<string, string>>,
	title: string
) {
	const sorted = Object.entries(concessions).sort(([a], [b]) => a.localeCompare(b));
	return bytesToHex(
		sha256(new TextEncoder().encode(JSON.stringify([templateVersionId, title, sorted])))
	);
}

async function patchBuyerLinkMetadata(
	ctx: MutationCtx,
	link: LiveBuyerLink,
	root: Doc<'savedContracts'>
) {
	const nextTitle = root.title;
	const nextBuyerName = buyerName(root);
	if (
		link.currentView.title === nextTitle &&
		link.currentView.buyerName === nextBuyerName &&
		link.currentView.buyerRefreshable === (root.buyer.kind === 'hubspot')
	)
		return;
	await ctx.db.patch('buyerLinks', link._id, {
		currentView: {
			...link.currentView,
			title: nextTitle,
			buyerName: nextBuyerName,
			buyerRefreshable: root.buyer.kind === 'hubspot',
			...(link.currentView.title !== nextTitle
				? {
						displayIdentity: displayIdentityFor(
							link.currentView.templateVersionId,
							link.currentView.concessions,
							nextTitle
						)
					}
				: {})
		}
	});
}

/** Auto-sync buyer link concessions whenever a save or approval leaves 0 pending & 0 rejected. */
export async function syncBuyerLink(
	ctx: MutationCtx,
	root: Doc<'savedContracts'>,
	preloaded?: PreloadedInvalidation
) {
	const link = await liveLinkFor(ctx, root._id);
	if (!link || link.companyId !== root.companyId) return;
	const nextConcessions = approvedConcessionMap(root.concessions);
	const nextTitle = root.title;
	const nextBuyerName = buyerName(root);
	const prevView = link.currentView;
	const concessionsChanged =
		Object.keys(prevView.concessions).length !== Object.keys(nextConcessions).length ||
		Object.entries(prevView.concessions).some(
			([id, value]) => nextConcessions[id as Id<'playbookItems'>] !== value
		);
	if (!concessionsChanged) {
		await patchBuyerLinkMetadata(ctx, link, root);
		return;
	}
	await ctx.db.patch('buyerLinks', link._id, {
		currentView: {
			templateVersionId: root.templateVersionId,
			title: nextTitle,
			buyerName: nextBuyerName,
			buyerRefreshable: root.buyer.kind === 'hubspot',
			concessions: nextConcessions,
			contentRevision: prevView.contentRevision + 1,
			displayIdentity: displayIdentityFor(root.templateVersionId, nextConcessions, nextTitle)
		}
	});
	await deleteAffectedComments(
		ctx,
		root,
		prevView.concessions,
		nextConcessions,
		prevView.contentRevision,
		preloaded
	);
}

/** Immediately pull back a revoked concession from a live buyer link while holding pending edits. */
export async function retractBuyerLinkConcession(
	ctx: MutationCtx,
	root: Doc<'savedContracts'>,
	itemId: Id<'playbookItems'>,
	preloaded?: PreloadedInvalidation
) {
	const link = await liveLinkFor(ctx, root._id);
	if (!link || link.companyId !== root.companyId || !(itemId in link.currentView.concessions))
		return;
	const prevView = link.currentView;
	const { [itemId]: _removed, ...nextConcessions } = prevView.concessions;
	const nextTitle = root.title;
	const nextBuyerName = buyerName(root);
	await ctx.db.patch('buyerLinks', link._id, {
		currentView: {
			templateVersionId: prevView.templateVersionId,
			title: nextTitle,
			buyerName: nextBuyerName,
			buyerRefreshable: root.buyer.kind === 'hubspot',
			concessions: nextConcessions,
			contentRevision: prevView.contentRevision + 1,
			displayIdentity: displayIdentityFor(prevView.templateVersionId, nextConcessions, nextTitle)
		}
	});
	await deleteAffectedComments(
		ctx,
		root,
		prevView.concessions,
		nextConcessions,
		prevView.contentRevision,
		preloaded
	);
}

/** Sync buyer link title and HubSpot buyer company name on rename / recipient refresh. */
export async function syncBuyerLinkMetadata(ctx: MutationCtx, root: Doc<'savedContracts'>) {
	const link = await liveLinkFor(ctx, root._id);
	if (!link || link.companyId !== root.companyId) return;
	await patchBuyerLinkMetadata(ctx, link, root);
}

/** Public acquisition depends only on the pointer, immutable template and live gates. */
async function resolveView(ctx: QueryCtx, token: string) {
	if (!isBuyerCode(token)) return null;
	const link = await ctx.db
		.query('buyerLinks')
		.withIndex('by_token', (q) => q.eq('token', token))
		.unique();
	if (!link?.currentView) return null;
	const company = await availableCompany(ctx, link.companyId);
	return company ? { link, view: link.currentView, company } : null;
}

/** Discussion/activity paths additionally require the actual current contract. */
export async function resolveAccess(ctx: QueryCtx, token: string) {
	const found = await resolveView(ctx, token);
	if (!found) return null;
	const contract = await ctx.db.get('savedContracts', found.link.contractId);
	return contract?.companyId === found.link.companyId ? { ...found, contract } : null;
}
export const resolve = resolveAccess;

/** Create the permanent buyer link once the contract has 0 pending & 0 rejected concessions. */
export const capture = internalMutation({
	args: {
		...sellerArgs,
		operationId: v.string(),
		expectedStateRevision: v.number(),
		token: v.string()
	},
	returns: linkCapture,
	handler: async (ctx, args) => {
		const { access, contract } = await seller(ctx, args);
		validateOperationId(args.operationId);
		const key = actionKey(access, 'buyer-link', args.operationId);
		const inputs = JSON.stringify([args.id, args.expectedStateRevision, 'buyer-link']);
		const prior = await receipt(ctx, key, inputs);
		if (prior) {
			if (prior.companyId !== access.companyId || prior.contractId !== args.id)
				throw new ConvexError('This link request is unavailable.');
			const link = await linkFor(ctx, args.id);
			if (!link?.currentView) throw new ConvexError('This link is unavailable.');
			return { ...summary(link), created: true };
		}
		const existing = await linkFor(ctx, args.id);
		if (existing?.currentView) return { ...summary(existing), created: false };
		if (existing) throw new ConvexError('This link is unavailable.');

		await requireContractWork(ctx, contract);
		if (contract.root.stateRevision !== args.expectedStateRevision)
			throw new ConvexError(
				'The saved contract changed. Review the current contract and try again.'
			);
		if (!contractReadiness(contract.root.concessions).ready)
			throw new ConvexError('Approve or remove pending concessions before sharing a buyer link.');
		if (!isBuyerCode(args.token)) throw new ConvexError('Invalid link request.');
		if (
			await ctx.db
				.query('buyerLinks')
				.withIndex('by_token', (q) => q.eq('token', args.token))
				.unique()
		)
			throw new ConvexError(buyerTokenCollision);

		const concessions = approvedConcessionMap(contract.root.concessions);
		const createdAt = Date.now();
		const value = {
			companyId: access.companyId,
			contractId: args.id,
			creatorId: access.profile._id,
			token: args.token,
			createdAt,
			currentView: {
				templateVersionId: contract.root.templateVersionId,
				title: contract.root.title,
				buyerName: buyerName(contract.root),
				buyerRefreshable: contract.root.buyer.kind === 'hubspot',
				concessions,
				contentRevision: 1,
				displayIdentity: displayIdentityFor(
					contract.root.templateVersionId,
					concessions,
					contract.root.title
				)
			}
		};
		const id = await ctx.db.insert('buyerLinks', value);
		await markDirectoryBuyerLinkPublished(ctx, args.id, value.token, access.profile._id);
		const result = { id, token: value.token, createdAt, created: true };
		await remember(ctx, access.companyId, key, inputs, JSON.stringify(result), args.id);
		return result;
	}
});

/** One current link snapshot and verified audience for buyer links and seller buyer-preview. */
export const pageContext = query({
	args: tokenArgs,
	returns: v.union(
		v.object({ kind: v.literal('unavailable') }),
		v.object({ kind: v.literal('account-error') }),
		v.object({
			kind: v.literal('current'),
			audience: v.literal('buyer'),
			buyerName: v.union(v.string(), v.null()),
			companyName: v.string(),
			title: v.string(),
			buyerRefreshable: v.boolean(),
			templateVersionId: v.id('templateVersions')
		}),
		v.object({
			kind: v.literal('current'),
			audience: v.literal('seller'),
			contractId: v.id('savedContracts'),
			buyerName: v.union(v.string(), v.null()),
			companyName: v.string(),
			title: v.string(),
			buyerRefreshable: v.boolean(),
			templateVersionId: v.id('templateVersions')
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
		const contract = member ? await ctx.db.get('savedContracts', found.link.contractId) : null;
		if (member && contract?.companyId === found.link.companyId) {
			return {
				kind: 'current' as const,
				audience: 'seller' as const,
				contractId: contract._id,
				buyerName: found.view.buyerName,
				companyName: found.company.name,
				title: found.view.title,
				buyerRefreshable: found.view.buyerRefreshable && env.HUBSPOT_ENABLED === 'true',
				templateVersionId: found.view.templateVersionId
			};
		}
		return {
			kind: 'current' as const,
			audience: 'buyer' as const,
			buyerName: found.view.buyerName,
			companyName: found.company.name,
			title: found.view.title,
			buyerRefreshable: found.view.buyerRefreshable && env.HUBSPOT_ENABLED === 'true',
			templateVersionId: found.view.templateVersionId
		};
	}
});

const unbiasedByteLimit = Math.floor(256 / buyerCodeAlphabet.length) * buyerCodeAlphabet.length;
function buyerCode() {
	let code = '';
	while (code.length < buyerCodeLength) {
		const bytes = new Uint8Array(buyerCodeLength - code.length);
		crypto.getRandomValues(bytes);
		for (const byte of bytes) {
			if (byte < unbiasedByteLimit) code += buyerCodeAlphabet[byte % buyerCodeAlphabet.length];
		}
	}
	return code;
}

export const ensureLatest = action({
	args: {
		...sellerArgs,
		operationId: v.string(),
		expectedStateRevision: v.number()
	},
	returns: linkCapture,
	handler: async (ctx, args): Promise<Infer<typeof linkCapture>> => {
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				return await ctx.runMutation(internal.buyerLinks.capture, {
					...args,
					token: buyerCode()
				});
			} catch (error) {
				if (!(error instanceof ConvexError) || error.data !== buyerTokenCollision) throw error;
			}
		}
		throw new ConvexError('We couldn’t allocate a link code. Try again.');
	}
});

/** Small reactive state for a buyer link (no template blocks). */
export const currentState = query({
	args: tokenArgs,
	returns: buyerDocumentState,
	handler: async (ctx, { token }) => {
		const found = await resolveView(ctx, token);
		if (!found) return { kind: 'unavailable' as const };
		const { link, view } = found;
		const appliedOverlays =
			Object.keys(view.concessions).length > 0
				? await readAppliedOverlays(
						await versionReader(ctx, view.templateVersionId, link.companyId, true),
						view.concessions
					)
				: [];
		return {
			kind: 'current' as const,
			companyName: found.company.name,
			buyerName: view.buyerName,
			buyerRefreshable: view.buyerRefreshable && env.HUBSPOT_ENABLED === 'true',
			templateVersionId: view.templateVersionId,
			title: view.title,
			contentRevision: view.contentRevision,
			displayIdentity: view.displayIdentity,
			concessions: view.concessions,
			appliedOverlays
		};
	}
});

/** Immutable template blocks and raw buyer explanations, fetched once per templateVersionId. */
export const templateContent = query({
	args: { token: v.string(), templateVersionId: v.id('templateVersions') },
	returns: buyerTemplateContent,
	handler: async (ctx, { token, templateVersionId }) => {
		const found = await resolveView(ctx, token);
		if (!found || found.view.templateVersionId !== templateVersionId)
			throw new ConvexError('This link is unavailable.');
		const reader = await versionReader(ctx, templateVersionId, found.link.companyId, true);
		const [blocks, rawExplanations] = await Promise.all([
			reader.blocks(),
			reader.readBuyerExplanations()
		]);
		const result = {
			templateVersionId,
			blocks,
			explanations: rawExplanations.map((item) => ({
				itemId: item._id,
				trigger: item.trigger,
				explanation: item.explanation
			}))
		};
		if (getConvexSize(result) > 15_000_000)
			throw new ConvexError('This contract exceeds supported response capacity.');
		return result;
	}
});

/** One consistent link/template snapshot for Word generation. */
export const downloadSnapshot = query({
	args: { token: v.string(), displayIdentity: v.string() },
	returns: buyerDownloadSnapshot,
	handler: async (ctx, { token, displayIdentity }) => {
		const found = await resolveView(ctx, token);
		if (!found || found.view.displayIdentity !== displayIdentity)
			throw new ConvexError(
				'The displayed contract changed. Review the current contract and try again.'
			);
		const { link, view } = found;
		const reader = await versionReader(ctx, view.templateVersionId, link.companyId, true);
		// Reserve native read headroom for the link, company, and template wrappers.
		if (reader.readBytes > 12_000_000) return { kind: 'too-large' as const };
		const [blocks, appliedOverlays] = await Promise.all([
			reader.blocks(),
			Object.keys(view.concessions).length > 0
				? readAppliedOverlays(reader, view.concessions)
				: Promise.resolve([])
		]);
		const result = {
			kind: 'ready' as const,
			title: view.title,
			blocks,
			concessions: view.concessions,
			appliedOverlays
		};
		return getConvexSize(result) > 15_000_000 ? { kind: 'too-large' as const } : result;
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
