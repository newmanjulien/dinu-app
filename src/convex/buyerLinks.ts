import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { ConvexError, getConvexSize, v, type Infer } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
	action,
	internalMutation,
	query,
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
import { canonicalJson } from '../lib/document/canonical-json';
import { textPrefix } from '../lib/text';
import { helpPreferences, profileView } from './accountViews';
import { accessibleContract, availableCompany, memberForCompany, requireMembership } from './auth';
import {
	buyerDocumentState,
	buyerTemplateContent,
	linkCapture,
	linkSummary,
	publicStatus
} from './buyerValidators';
import { buyerName } from './contractBuyer';
import { markDirectoryBuyerLinkPublished } from './contractDirectory';
import { requireContractWork } from './contractPolicy';
import { seller } from './contractState';
import { deleteAffectedComments, type PreloadedInvalidation } from './discussionInvalidation';
import { actionKey, receipt, remember, validateOperationId } from './operationReceipts';
import { role } from './permissions';
import { assertStorageCapacity } from './storageCapacity';
import { readAppliedOverlays, versionReader } from './templates';

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
	for await (const link of ctx.db
		.query('buyerLinks')
		.withIndex('by_companyId_and_creatorId', (q) =>
			q.eq('companyId', companyId).eq('creatorId', creatorId)
		)) {
		if (link.currentView !== null) return true;
	}
	return false;
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
	if (link.currentView.title === nextTitle && link.currentView.buyerName === nextBuyerName) return;
	await ctx.db.patch('buyerLinks', link._id, {
		currentView: {
			...link.currentView,
			title: nextTitle,
			buyerName: nextBuyerName,
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
	const concessionsChanged = canonicalJson(prevView.concessions) !== canonicalJson(nextConcessions);
	if (!concessionsChanged) {
		await patchBuyerLinkMetadata(ctx, link, root);
		return;
	}
	await ctx.db.patch('buyerLinks', link._id, {
		currentView: {
			templateVersionId: root.templateVersionId,
			title: nextTitle,
			buyerName: nextBuyerName,
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

async function linkedDirectoryRow(
	ctx: QueryCtx,
	row: Doc<'contractDirectory'>,
	companyId: Id<'company'>
) {
	const link = await liveLinkFor(ctx, row.contractId);
	return link && link.companyId === companyId ? browseRow(link, row) : null;
}

/** Public acquisition depends only on the pointer, immutable template and live gates. */
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
			buyerName: v.union(v.string(), v.null())
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
			buyerName: found.view.buyerName
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
		const link = await liveLinkFor(ctx, root._id);
		return link ? summary(link) : null;
	}
});

export async function hasSingleActiveOwnLink(
	ctx: QueryCtx,
	companyId: Id<'company'>,
	creatorId: Id<'profiles'>
) {
	let activeCount = 0;
	for await (const link of ctx.db
		.query('buyerLinks')
		.withIndex('by_companyId_and_creatorId', (q) =>
			q.eq('companyId', companyId).eq('creatorId', creatorId)
		)) {
		if (link.currentView === null) continue;
		activeCount++;
		if (activeCount > 1) return false;
	}
	return activeCount === 1;
}

export const dashboardPresence = query({
	args: { membershipId: v.id('memberships') },
	returns: v.object({
		hasActive: v.boolean(),
		hasCreatedOneLink: v.boolean()
	}),
	handler: async (ctx, { membershipId }) => {
		const access = await requireMembership(ctx, membershipId);
		const [row, hasCreatedOneLink] = await Promise.all([
			ctx.db
				.query('contractDirectory')
				.withIndex('by_companyId_hasBuyerLink_hasUnreadComment_buyerLinkCreatedAt', (q) =>
					q.eq('companyId', access.companyId).eq('hasBuyerLink', true)
				)
				.first(),
			hasSingleActiveOwnLink(ctx, access.companyId, access.profile._id)
		]);
		return { hasActive: Boolean(row), hasCreatedOneLink };
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
		const term = textPrefix((args.search ?? '').trim(), 200);
		if (term) {
			const result = await ctx.db
				.query('contractDirectory')
				.withSearchIndex('search_title', (q) =>
					q.search('title', term).eq('companyId', access.companyId).eq('hasBuyerLink', true)
				)
				.paginate(args.paginationOpts);
			const rows = await Promise.all(
				result.page.map((row) => linkedDirectoryRow(ctx, row, access.companyId))
			);
			return { ...result, page: rows.filter((row) => row !== null) };
		}
		// Unread links stay ahead of read links across page boundaries.
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
				concessions,
				contentRevision: 1,
				displayIdentity: displayIdentityFor(
					contract.root.templateVersionId,
					concessions,
					contract.root.title
				)
			}
		};
		await assertStorageCapacity(ctx, { documents: 2, bytes: getConvexSize(value) + 2048 });
		const id = await ctx.db.insert('buyerLinks', value);
		await markDirectoryBuyerLinkPublished(ctx, args.id, createdAt);
		const result = { id, token: value.token, createdAt, created: true };
		await remember(ctx, access.companyId, key, inputs, JSON.stringify(result), args.id);
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
		if (!found) throw new ConvexError('This link is unavailable.');
		const { link, view } = found;
		const appliedOverlays =
			Object.keys(view.concessions).length > 0
				? await readAppliedOverlays(
						await versionReader(ctx, view.templateVersionId, link.companyId, true),
						view.concessions
					)
				: [];
		return {
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
