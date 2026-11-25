import { requestBuyerRefresh } from './hubspotRecipients';
import { ConvexError, v } from 'convex/values';
import {
	action,
	internalMutation,
	internalQuery,
	query,
	type QueryCtx,
	type MutationCtx
} from './_generated/server';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { accessibleContract, requireMembership, type CompanyAccess } from './auth';
import {
	connectionToken,
	hubspot,
	resolveDeal,
	readDeal,
	record,
	objectId,
	nextCursor as decodeNextCursor,
	HubSpotError
} from './hubspotApi';
import { activity, blockLink } from './hubspotRecords';
import { actionKey, actorOf, receipt, remember, validateOperationId } from './operationReceipts';
import { createContract, metadataOf } from './contracts';
import { contractMetadata } from './savedContractValidators';
import { env } from './_generated/server';
import schema from './schema';
import { hubspotLink } from './hubspotValidators';
import { installation, markDealUnavailable } from './contractPolicy';
import { lifecycle } from './hubspotInstallation';
import {
	accessibleContractState,
	hasOtherHubspotAssociation,
	patchContract,
	type Contract
} from './contractState';

const operationArgs = {
	membershipId: v.id('memberships'),
	operationId: v.string(),
	dealId: v.string(),
	expectedConnectionId: v.optional(v.id('hubspotConnections')),
	contractId: v.optional(v.id('savedContracts')),
	expectedGeneration: v.optional(v.union(v.number(), v.null()))
};
const result = v.union(
	v.object({
		status: v.literal('created'),
		id: v.id('savedContracts'),
		contract: contractMetadata
	}),
	v.object({ status: v.literal('deleted') })
);
const linkOutcome = v.union(
	result,
	v.object({ status: v.literal('deal-already-linked') }),
	v.object({ status: v.literal('installation-retired') })
);
const occupiedReceipt = 'hubspot:deal-already-linked:v1';
const retiredReceipt = 'hubspot:installation-retired:v1';
async function receiptOutcome(ctx: QueryCtx, value: string, access: CompanyAccess) {
	if (value === occupiedReceipt) return { status: 'deal-already-linked' as const };
	if (value === retiredReceipt) return { status: 'installation-retired' as const };
	const id = ctx.db.normalizeId('savedContracts', value);
	const contract = id ? await accessibleContractState(ctx, id, access) : null;
	return contract
		? {
				status: 'created' as const,
				id: contract.root._id,
				contract: metadataOf(contract)
			}
		: { status: 'deleted' as const };
}
function publicOutcome(outcome: import('convex/values').Infer<typeof linkOutcome>) {
	if (outcome.status === 'installation-retired')
		throw new ConvexError({
			code: 'hubspot-installation-retired',
			message: 'This HubSpot installation was removed. Start a new request.'
		});
	if (outcome.status === 'deal-already-linked')
		throw new ConvexError({
			code: 'hubspot-deal-already-linked',
			message: 'This deal is already linked to another contract.'
		});
	return outcome;
}
function input(args: {
	dealId: string;
	contractId?: string;
	expectedGeneration?: number | null;
	expectedConnectionId?: string;
}) {
	return JSON.stringify([
		args.dealId,
		args.contractId ?? null,
		args.expectedGeneration ?? null,
		...(args.expectedConnectionId ? [args.expectedConnectionId] : [])
	]);
}
/** Receipt read/refusal write serializes against every competing final commit. */
async function operationOutcome(
	ctx: MutationCtx,
	args: import('convex/values').Infer<typeof operationValidator>,
	access: CompanyAccess,
	actualConnectionId?: Doc<'hubspotConnections'>['_id']
) {
	validateOperationId(args.operationId);
	const key = actionKey(access, args.contractId ? 'relink' : 'create', args.operationId);
	const inputs = input(args);
	const prior = await receipt(ctx, key, inputs);
	if (prior) return receiptOutcome(ctx, prior.result, access);
	const targetId = args.expectedConnectionId ?? actualConnectionId;
	const target = targetId ? await ctx.db.get('hubspotConnections', targetId) : null;
	if (target && target.companyId !== access.companyId)
		throw new ConvexError('HubSpot changed. Reload before linking a deal.');
	if (
		args.contractId &&
		!accessibleContract(await ctx.db.get('savedContracts', args.contractId), access)
	)
		throw new ConvexError('This contract was deleted.');
	const legacyRetired =
		!args.expectedConnectionId && (await lifecycle(ctx, access.companyId))?.removedAt !== undefined;
	const retired = legacyRetired || Boolean(targetId && (!target || target.status === 'retiring'));
	if (!retired) return null;
	await remember(ctx, access.companyId, key, inputs, retiredReceipt);
	return { status: 'installation-retired' as const };
}
const operationValidator = v.object(operationArgs);
export const prepare = internalMutation({
	args: operationArgs,
	returns: v.union(linkOutcome, v.null()),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		return operationOutcome(ctx, args, access);
	}
});
export const commit = internalMutation({
	args: {
		...operationArgs,
		connectionId: v.id('hubspotConnections'),
		credentialGeneration: v.number(),
		name: v.string()
	},
	returns: linkOutcome,
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		const key = actionKey(access, args.contractId ? 'relink' : 'create', args.operationId),
			inputs = input(args);
		const prior = await operationOutcome(ctx, args, access, args.connectionId);
		if (prior) return prior;
		if (args.expectedConnectionId && args.expectedConnectionId !== args.connectionId)
			throw new ConvexError('HubSpot changed. Reload before linking a deal.');
		const connection = await ctx.db.get('hubspotConnections', args.connectionId);
		if (
			!connection ||
			connection.companyId !== access.companyId ||
			connection.status !== 'connected' ||
			connection.generation !== args.credentialGeneration
		)
			throw new ConvexError('HubSpot changed. Try again.');
		const current = args.contractId
			? await accessibleContractState(ctx, args.contractId, access)
			: null;
		if (args.contractId) {
			if (!current) throw new ConvexError('This contract was deleted.');
			if (current.hubspot) {
				const sameInstallation =
					current.hubspot.connectionId === connection._id &&
					current.hubspot.accountId === connection.accountId;
				if (
					(sameInstallation && current.hubspot.availability !== 'unavailable') ||
					current.hubspot.generation !== args.expectedGeneration
				)
					throw new ConvexError('This HubSpot link changed. Reload before trying again.');
			} else if (args.expectedGeneration !== null) {
				throw new ConvexError('This HubSpot link changed. Reload before trying again.');
			}
		} else if (args.expectedGeneration !== undefined) {
			throw new ConvexError('Invalid HubSpot creation request.');
		}
		if (
			await hasOtherHubspotAssociation(
				ctx,
				access.companyId,
				{ connectionId: connection._id, dealId: args.dealId },
				current?.root._id
			)
		) {
			await remember(ctx, access.companyId, key, inputs, occupiedReceipt);
			return { status: 'deal-already-linked' as const };
		}
		let contract: Contract;
		if (current) {
			if (current.hubspot)
				await blockLink(ctx, current.root.companyId, current.root._id, current.hubspot.generation);
			const changes = {
				title: args.name,
				buyer: { kind: 'hubspot' as const, company: null },
				hubspot: {
					connectionId: connection._id,
					accountId: connection.accountId,
					dealId: args.dealId,
					generation: (current.hubspot?.generation ?? 0) + 1,
					availability: 'available' as const
				}
			};
			contract = await patchContract(ctx, current, changes);
		} else {
			contract = await createContract(ctx, access, args.name, {
				connectionId: connection._id,
				accountId: connection.accountId,
				dealId: args.dealId,
				generation: 1,
				availability: 'available'
			});
			await activity(ctx, contract, actorOf(access.profile), key, 'created');
		}
		await requestBuyerRefresh(ctx, contract.root);
		await remember(ctx, access.companyId, key, inputs, contract.root._id, contract.root._id);
		return {
			status: 'created' as const,
			id: contract.root._id,
			contract: metadataOf(contract)
		};
	}
});
export const link = action({
	args: operationArgs,
	returns: result,
	handler: async (ctx, args): Promise<import('convex/values').Infer<typeof result>> => {
		const previous = await ctx.runMutation(internal.hubspotDeals.prepare, args);
		if (previous) return publicOutcome(previous);
		try {
			const connection = await connectionToken(
				ctx,
				await ctx.runQuery(internal.hubspotConnections.forMember, {
					membershipId: args.membershipId
				})
			);
			if (args.expectedConnectionId && args.expectedConnectionId !== connection._id)
				throw new ConvexError('HubSpot changed. Reload before linking a deal.');
			const deal = await resolveDeal(ctx, connection, args.dealId);
			const outcome = await ctx.runMutation(internal.hubspotDeals.commit, {
				...args,
				name: deal.name,
				connectionId: connection._id,
				credentialGeneration: connection.generation
			});
			return publicOutcome(outcome);
		} catch (cause) {
			// Resolve retirement/accepted work atomically even if token/provider work failed first.
			const final = await ctx.runMutation(internal.hubspotDeals.prepare, args);
			if (final) return publicOutcome(final);
			throw cause;
		}
	}
});

/** Live local ownership, separate from the cached provider metadata. */
export const eligibility = query({
	args: {
		membershipId: v.id('memberships'),
		dealIds: v.array(v.string()),
		accountId: v.string(),
		installedAt: v.number(),
		requestIdentity: v.string(),
		contractId: v.optional(v.id('savedContracts'))
	},
	returns: v.union(
		v.object({
			linkedDealIds: v.array(v.string()),
			accountId: v.string(),
			installedAt: v.number(),
			requestIdentity: v.string()
		}),
		v.null()
	),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		if (
			args.dealIds.length > 13 ||
			args.dealIds.some((id) => !id.trim() || id.length > 200) ||
			args.requestIdentity.length > 2000
		)
			throw new ConvexError('Invalid HubSpot eligibility request.');
		if (
			args.contractId &&
			!accessibleContract(await ctx.db.get('savedContracts', args.contractId), access)
		)
			throw new ConvexError('This contract was deleted.');
		const connection = await installation(ctx, access.companyId);
		if (
			!connection ||
			connection.status !== 'connected' ||
			env.HUBSPOT_ENABLED !== 'true' ||
			connection.accountId !== args.accountId ||
			connection.installedAt !== args.installedAt
		)
			return null;
		const ids = [...new Set(args.dealIds)];
		const occupied = await Promise.all(
			ids.map((id) =>
				hasOtherHubspotAssociation(
					ctx,
					access.companyId,
					{ connectionId: connection._id, dealId: id },
					args.contractId
				)
			)
		);
		return {
			linkedDealIds: ids.filter((_, index) => occupied[index]),
			accountId: connection.accountId,
			installedAt: connection.installedAt,
			requestIdentity: args.requestIdentity
		};
	}
});
export const list = action({
	args: {
		membershipId: v.id('memberships'),
		search: v.string(),
		// An empty cursor starts a full browse after the recent candidates are exhausted.
		cursor: v.optional(v.string())
	},
	returns: v.object({
		deals: v.array(v.object({ id: v.string(), name: v.string() })),
		hasMore: v.boolean(),
		nextCursor: v.union(v.string(), v.null())
	}),
	handler: async (
		ctx,
		args
	): Promise<{
		deals: { id: string; name: string }[];
		hasMore: boolean;
		nextCursor: string | null;
	}> => {
		const connection = await connectionToken(
			ctx,
			await ctx.runQuery(internal.hubspotConnections.forMember, { membershipId: args.membershipId })
		);
		const search = args.search.trim().slice(0, 200);
		const limit = search ? 3 : 12;
		const browsing = !search && args.cursor !== undefined;
		if (args.cursor !== undefined && (search || args.cursor.length > 200))
			throw new ConvexError('Invalid HubSpot browse cursor.');
		const params = new URLSearchParams({ limit: String(limit), properties: 'dealname' });
		if (args.cursor) params.set('after', args.cursor);
		const data = await hubspot(
			ctx,
			connection,
			browsing ? `/crm/v3/objects/deals?${params}` : '/crm/v3/objects/deals/search',
			browsing
				? { method: 'GET' }
				: {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							...(search ? { query: search } : {}),
							properties: ['dealname'],
							sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
							limit
						})
					},
			!browsing
		);
		const page = record(data);
		if (!Array.isArray(page.results)) throw new HubSpotError(502);
		const deals = page.results.map((value) => {
			const deal = record(value);
			const id = objectId(deal.id);
			if (deal.archived !== undefined && typeof deal.archived !== 'boolean')
				throw new HubSpotError(502);
			const properties = record(deal.properties);
			if (properties.dealname != null && typeof properties.dealname !== 'string')
				throw new HubSpotError(502);
			return { id, name: properties.dealname, archived: deal.archived };
		});
		const nextCursor = decodeNextCursor(page);
		if (browsing && nextCursor === args.cursor)
			throw new ConvexError('HubSpot couldn’t load the next deals. Try again.');
		const seen = new Set<string>();
		return {
			deals: deals
				.filter(
					(deal): deal is typeof deal & { name: string } =>
						!deal.archived && typeof deal.name === 'string'
				)
				.filter((deal) => {
					if (seen.has(deal.id)) return false;
					seen.add(deal.id);
					return true;
				})
				.slice(0, limit)
				.map(({ id, name }) => ({ id, name })),
			hasMore: nextCursor !== null,
			// Search exhaustion cannot establish full-list exhaustion because indexing can lag.
			nextCursor: search ? null : browsing ? nextCursor : ''
		};
	}
});

// Only the authenticated snapshot and commit touch authorization; provider failures are indeterminate.
export const checkTarget = internalQuery({
	args: { membershipId: v.id('memberships'), contractId: v.id('savedContracts') },
	returns: v.union(
		v.object({ connection: schema.doc('hubspotConnections'), link: hubspotLink }),
		v.null()
	),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		const contract = await accessibleContractState(ctx, args.contractId, access);
		if (!contract) throw new ConvexError('This contract was deleted.');
		const connection = await installation(ctx, access.companyId);
		if (
			!contract.hubspot ||
			!connection ||
			connection._id !== contract.hubspot.connectionId ||
			connection.accountId !== contract.hubspot.accountId ||
			connection.status !== 'connected' ||
			env.HUBSPOT_ENABLED !== 'true'
		)
			return null;
		return { connection, link: contract.hubspot };
	}
});
export const unavailable = internalMutation({
	args: {
		membershipId: v.id('memberships'),
		contractId: v.id('savedContracts'),
		link: hubspotLink,
		credentialGeneration: v.number()
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		const contract = await accessibleContractState(ctx, args.contractId, access);
		if (!contract) return false;
		const connection = await installation(ctx, access.companyId);
		const link = contract.hubspot;
		if (
			!link ||
			!connection ||
			connection._id !== args.link.connectionId ||
			connection.accountId !== args.link.accountId ||
			connection.status !== 'connected' ||
			connection.generation !== args.credentialGeneration ||
			link.connectionId !== connection._id ||
			link.accountId !== connection.accountId ||
			link.dealId !== args.link.dealId ||
			link.generation !== args.link.generation
		)
			return false;
		await markDealUnavailable(ctx, contract);
		return true;
	}
});
export const check = action({
	args: { membershipId: v.id('memberships'), contractId: v.id('savedContracts') },
	returns: v.object({
		outcome: v.union(v.literal('available'), v.literal('unavailable'), v.literal('indeterminate')),
		generation: v.optional(v.number())
	}),
	handler: async (
		ctx,
		args
	): Promise<{ outcome: 'available' | 'unavailable' | 'indeterminate'; generation?: number }> => {
		const target = await ctx.runQuery(internal.hubspotDeals.checkTarget, args);
		if (!target) return { outcome: 'indeterminate' };
		const generation = target.link.generation;
		if (target.link.availability === 'unavailable') return { outcome: 'unavailable', generation };
		let connection = target.connection;
		try {
			connection = await connectionToken(ctx, connection);
			if (await readDeal(ctx, connection, target.link.dealId))
				return { outcome: 'available', generation };
		} catch {
			// No global credential/scope/transport failure establishes object loss.
			return { outcome: 'indeterminate', generation };
		}
		const marked = await ctx.runMutation(internal.hubspotDeals.unavailable, {
			...args,
			link: target.link,
			credentialGeneration: connection.generation
		});
		return { outcome: marked ? 'unavailable' : 'indeterminate', generation };
	}
});
