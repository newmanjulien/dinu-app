import { ConvexError, v } from 'convex/values';
import { action, internalMutation, internalQuery, query, type QueryCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { accessibleContract, requireMembership, type CompanyAccess } from './auth';
import { connectionToken, hubspot, resolveDeal, readDeal } from './hubspotApi';
import { actionKey, activity, actorOf, receipt, remember, blockLink } from './hubspotRecords';
import { createContract, metadataOf } from './contracts';
import { contractMetadata } from './savedContractValidators';
import { writeDirectory } from './contractDirectory';
import { env } from './_generated/server';
import schema from './schema';
import { hubspotLink } from './hubspotValidators';
import { installation, markDealUnavailable } from './contractPolicy';

const operationArgs = {
	membershipId: v.id('memberships'),
	operationId: v.string(),
	dealId: v.string(),
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
const linkOutcome = v.union(result, v.object({ status: v.literal('deal-already-linked') }));
const occupiedReceipt = 'hubspot:deal-already-linked:v1';
async function receiptOutcome(ctx: QueryCtx, value: string, access: CompanyAccess) {
	if (value === occupiedReceipt) return { status: 'deal-already-linked' as const };
	const id = ctx.db.normalizeId('savedContracts', value);
	const contract = id ? accessibleContract(await ctx.db.get('savedContracts', id), access) : null;
	return contract
		? { status: 'created' as const, id: contract._id, contract: metadataOf(contract) }
		: { status: 'deleted' as const };
}
function publicOutcome(outcome: import('convex/values').Infer<typeof linkOutcome>) {
	if (outcome.status === 'deal-already-linked')
		throw new ConvexError({
			code: 'hubspot-deal-already-linked',
			message: 'This deal is already linked to another contract.'
		});
	return outcome;
}
function input(args: { dealId: string; contractId?: string; expectedGeneration?: number | null }) {
	return JSON.stringify([args.dealId, args.contractId ?? null, args.expectedGeneration ?? null]);
}
export const replay = internalQuery({
	args: operationArgs,
	returns: v.union(linkOutcome, v.null()),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		const row = await receipt(
			ctx,
			actionKey(access, args.contractId ? 'relink' : 'create', args.operationId),
			input(args)
		);
		if (!row) return null;
		return receiptOutcome(ctx, row.result, access);
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
		const prior = await receipt(ctx, key, inputs);
		if (prior) return receiptOutcome(ctx, prior.result, access);
		const connection = await ctx.db.get('hubspotConnections', args.connectionId);
		if (
			!connection ||
			connection.companyId !== access.companyId ||
			connection.status !== 'connected' ||
			connection.generation !== args.credentialGeneration
		)
			throw new ConvexError('HubSpot changed. Try again.');
		const current = args.contractId
			? accessibleContract(await ctx.db.get('savedContracts', args.contractId), access)
			: null;
		if (args.contractId) {
			if (!current) throw new ConvexError('This contract was deleted.');
			if (current.hubspot) {
				if (
					current.hubspot.availability !== 'unavailable' ||
					current.hubspot.generation !== args.expectedGeneration ||
					current.hubspot.connectionId !== connection._id ||
					current.hubspot.accountId !== connection.accountId
				)
					throw new ConvexError('This HubSpot link changed. Reload before trying again.');
			} else if (args.expectedGeneration !== null) {
				throw new ConvexError('This HubSpot link changed. Reload before trying again.');
			}
		} else if (args.expectedGeneration !== undefined) {
			throw new ConvexError('Invalid HubSpot creation request.');
		}
		// The range read shares the link transaction, so competing owners conflict.
		const owners = await ctx.db
			.query('savedContracts')
			.withIndex('by_companyId_and_hubspot_accountId_and_hubspot_dealId', (q) =>
				q
					.eq('companyId', access.companyId)
					.eq('hubspot.accountId', connection.accountId)
					.eq('hubspot.dealId', args.dealId)
			)
			.take(2);
		if (owners.some((owner) => owner._id !== current?._id)) {
			// Return rather than throw: the terminal refusal must survive an uncertain response.
			await remember(ctx, access.companyId, key, inputs, occupiedReceipt);
			return { status: 'deal-already-linked' as const };
		}
		let contract: Doc<'savedContracts'>;
		if (current) {
			if (current.hubspot)
				await blockLink(ctx, current.companyId, current._id, current.hubspot.generation);
			const changes = {
				buyerCompanyName: args.name,
				hubspot: {
					connectionId: connection._id,
					accountId: connection.accountId,
					dealId: args.dealId,
					generation: (current.hubspot?.generation ?? 0) + 1,
					availability: 'available' as const
				},
				stateVersion: current.stateVersion + 1
			};
			await ctx.db.patch('savedContracts', current._id, changes);
			contract = { ...current, ...changes };
			await writeDirectory(ctx, contract);
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
		await remember(ctx, access.companyId, key, inputs, contract._id);
		return { status: 'created' as const, id: contract._id, contract: metadataOf(contract) };
	}
});
export const link = action({
	args: operationArgs,
	returns: result,
	handler: async (ctx, args): Promise<import('convex/values').Infer<typeof result>> => {
		const previous = await ctx.runQuery(internal.hubspotDeals.replay, args);
		if (previous) return publicOutcome(previous);
		const connection = await connectionToken(
			ctx,
			await ctx.runQuery(internal.hubspotConnections.forMember, { membershipId: args.membershipId })
		);
		const deal = await resolveDeal(ctx, connection, args.dealId);
		const outcome = await ctx.runMutation(internal.hubspotDeals.commit, {
			...args,
			name: deal.name,
			connectionId: connection._id,
			credentialGeneration: connection.generation
		});
		return publicOutcome(outcome);
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
			ids.map(async (id) => {
				const owners = await ctx.db
					.query('contractDirectory')
					.withIndex('by_companyId_and_hubspot_accountId_and_hubspot_dealId', (q) =>
						q
							.eq('companyId', access.companyId)
							.eq('hubspot.accountId', connection.accountId)
							.eq('hubspot.dealId', id)
					)
					.take(2);
				return owners.some((owner) => owner.contractId !== args.contractId);
			})
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
	args: { membershipId: v.id('memberships'), search: v.string() },
	returns: v.object({
		deals: v.array(v.object({ id: v.string(), name: v.string() })),
		hasMore: v.boolean()
	}),
	handler: async (
		ctx,
		args
	): Promise<{
		deals: { id: string; name: string }[];
		hasMore: boolean;
	}> => {
		const connection = await connectionToken(
			ctx,
			await ctx.runQuery(internal.hubspotConnections.forMember, { membershipId: args.membershipId })
		);
		const search = args.search.trim().slice(0, 200);
		const limit = search ? 3 : 12;
		const data = await hubspot(
			ctx,
			connection,
			'/crm/v3/objects/deals/search',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					...(search ? { query: search } : {}),
					properties: ['dealname'],
					sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
					limit
				})
			},
			true
		);
		const seen = new Set<string>();
		return {
			deals: (data.results ?? [])
				.filter(
					(d: { archived?: boolean; properties?: { dealname?: string } }) =>
						!d.archived && typeof d.properties?.dealname === 'string'
				)
				.filter((d: { id: string }) => {
					const id = String(d.id);
					if (seen.has(id)) return false;
					seen.add(id);
					return true;
				})
				.slice(0, limit)
				.map((d: { id: string; properties: { dealname: string } }) => ({
					id: String(d.id),
					name: d.properties.dealname
				})),
			hasMore: Boolean(data.paging?.next?.after)
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
		const contract = accessibleContract(
			await ctx.db.get('savedContracts', args.contractId),
			access
		);
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
		const contract = accessibleContract(
			await ctx.db.get('savedContracts', args.contractId),
			access
		);
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
