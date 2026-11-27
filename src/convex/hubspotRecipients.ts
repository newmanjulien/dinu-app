import { RateLimiter } from '@convex-dev/rate-limiter';
import { v, type Infer } from 'convex/values';
import { components, internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import {
	env,
	internalAction,
	internalMutation,
	mutation,
	type MutationCtx,
	type QueryCtx
} from './_generated/server';
import { accessibleContract, availableCompany, requireMembership } from './auth';
import { resolveAccess, syncBuyerLinkMetadata } from './buyerLinks';
import { contractBuyerRefresh } from './contractValidators';
import { connectionToken, HubSpotError, resolveRecipient } from './hubspotApi';
import type { CredentialConnection } from './hubspotCredentials';
import { attachCredentials, connectionWithCredentials } from './hubspotCredentials';
import { activeDestination } from './hubspotInstallation';

const LEASE_MS = 240_000;
const buyerLimiter = new RateLimiter(components.rateLimiter, {
	buyerRefresh: { kind: 'fixed window', rate: 1, period: 45_000 }
});
const target = contractBuyerRefresh.omit('leaseUntil', 'dueAt', 'suppressed');
type Target = Infer<typeof target>;
const company = v.union(v.object({ id: v.string(), name: v.string() }), v.null());
const outcome = v.union(
	v.literal('resolved'),
	v.literal('empty'),
	v.literal('missing-capability'),
	v.literal('indeterminate')
);

async function eligible(ctx: QueryCtx, root: Doc<'savedContracts'>) {
	if (
		env.HUBSPOT_ENABLED !== 'true' ||
		root.buyer.kind !== 'hubspot' ||
		!(await availableCompany(ctx, root.companyId))
	)
		return null;
	const association = await ctx.db
		.query('contractHubspotAssociations')
		.withIndex('by_contractId', (q) => q.eq('contractId', root._id))
		.unique();
	if (
		!association ||
		association.companyId !== root.companyId ||
		association.availability !== 'available'
	)
		return null;
	const connection = await activeDestination(ctx, root.companyId, association);
	if (!connection || connection.status !== 'connected') return null;
	const capabilities = JSON.stringify([...connection.scopes].sort());
	return { association, connection, capabilities };
}

async function coordinator(ctx: QueryCtx, root: Doc<'savedContracts'>) {
	const row = await ctx.db
		.query('contractBuyerRefreshes')
		.withIndex('by_contractId', (q) => q.eq('contractId', root._id))
		.unique();
	if (row && row.companyId !== root.companyId) throw new Error('Invalid buyer refresh ownership.');
	return row;
}

/** Demand is coalesced without writing the stable association or content state. */
export async function requestBuyerRefresh(
	ctx: MutationCtx,
	root: Doc<'savedContracts'>,
	leaseMs = LEASE_MS
) {
	const current = await eligible(ctx, root);
	if (!current) return;
	const { association, connection, capabilities } = current;
	const now = Date.now(),
		prior = await coordinator(ctx, root);
	const sameDestination =
		prior?.associationId === association._id &&
		prior.connectionId === association.connectionId &&
		prior.accountId === association.accountId &&
		prior.dealId === association.dealId &&
		prior.generation === association.generation &&
		prior.installedAt === connection.installedAt &&
		prior.capabilities === capabilities;
	if (sameDestination && (prior.suppressed || prior.leaseUntil > now || prior.dueAt > now)) return;
	const expected: Target = {
		contractId: root._id,
		companyId: root.companyId,
		associationId: association._id,
		connectionId: connection._id,
		accountId: association.accountId,
		dealId: association.dealId,
		generation: association.generation,
		installedAt: connection.installedAt,
		capabilities,
		attempt: crypto.randomUUID()
	};
	const suppressed = !connection.scopes.includes('crm.objects.companies.read');
	const value = {
		...expected,
		leaseUntil: suppressed ? 0 : now + leaseMs,
		dueAt: now,
		suppressed
	};
	if (prior) await ctx.db.replace('contractBuyerRefreshes', prior._id, value);
	else await ctx.db.insert('contractBuyerRefreshes', value);
	if (!suppressed) await ctx.scheduler.runAfter(0, internal.hubspotRecipients.refresh, expected);
}

export const request = mutation({
	args: { membershipId: v.id('memberships'), contractId: v.id('savedContracts') },
	returns: v.null(),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		const root = accessibleContract(await ctx.db.get('savedContracts', args.contractId), access);
		if (root) await requestBuyerRefresh(ctx, root);
		return null;
	}
});

/** Public token demand is rate limited and coalesced; destinations stay server-owned. */
export const requestBuyer = mutation({
	args: { token: v.string() },
	returns: v.null(),
	handler: async (ctx, { token }) => {
		const found = await resolveAccess(ctx, token);
		if (found && (await buyerLimiter.limit(ctx, 'buyerRefresh', { key: token })).ok)
			await requestBuyerRefresh(ctx, found.contract, 45_000);
		return null;
	}
});

async function currentAttempt(ctx: QueryCtx, expected: Target) {
	const root = await ctx.db.get('savedContracts', expected.contractId);
	if (!root || root.companyId !== expected.companyId) return null;
	const current = await eligible(ctx, root);
	if (!current) return null;
	const { association, connection, capabilities } = current;
	const refresh = await coordinator(ctx, root);
	if (
		!refresh ||
		!(Object.keys(target.fields) as (keyof Target)[]).every(
			(key) => refresh[key] === expected[key]
		) ||
		association._id !== expected.associationId ||
		association.connectionId !== expected.connectionId ||
		association.accountId !== expected.accountId ||
		association.dealId !== expected.dealId ||
		association.generation !== expected.generation ||
		connection.installedAt !== expected.installedAt ||
		capabilities !== expected.capabilities
	)
		return null;
	return { root, ...current, refresh };
}

export const start = internalMutation({
	args: target.fields,
	returns: v.union(connectionWithCredentials, v.null()),
	handler: async (ctx, expected) => {
		const current = await currentAttempt(ctx, expected);
		if (!current || current.refresh.leaseUntil <= Date.now()) return null;
		await ctx.db.patch('contractBuyerRefreshes', current.refresh._id, {
			leaseUntil: Date.now() + LEASE_MS
		});
		return attachCredentials(ctx, current.connection);
	}
});

export const commit = internalMutation({
	args: { target, outcome, company, retryAfter: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const current = await currentAttempt(ctx, args.target);
		if (!current || current.refresh.leaseUntil <= Date.now()) return null;
		let nextRoot: Doc<'savedContracts'> | null = null;
		if (args.outcome === 'resolved' || args.outcome === 'empty') {
			if ((args.outcome === 'resolved') !== (args.company !== null))
				throw new Error('Invalid buyer observation.');
			if (
				args.company &&
				(!args.company.name.trim() || new TextEncoder().encode(args.company.name).length > 4096)
			)
				throw new Error('Invalid buyer name.');
			const buyer = { kind: 'hubspot' as const, company: args.company };
			const prior = current.root.buyer;
			if (
				prior.kind === 'hubspot' &&
				(prior.company?.id !== args.company?.id || prior.company?.name !== args.company?.name)
			) {
				nextRoot = {
					...current.root,
					buyer,
					metadataRevision: current.root.metadataRevision + 1
				};
			}
		}
		const successful = args.outcome === 'resolved' || args.outcome === 'empty';
		const refreshPatch = {
			leaseUntil: 0,
			dueAt:
				Date.now() + (successful ? 45_000 : Math.min(300_000, Math.max(2000, args.retryAfter))),
			suppressed: args.outcome === 'missing-capability'
		};
		if (nextRoot) {
			await ctx.db.patch('savedContracts', nextRoot._id, {
				buyer: nextRoot.buyer,
				metadataRevision: nextRoot.metadataRevision
			});
			await syncBuyerLinkMetadata(ctx, nextRoot);
		}
		await ctx.db.patch('contractBuyerRefreshes', current.refresh._id, refreshPatch);
		return null;
	}
});

export const refresh = internalAction({
	args: target.fields,
	returns: v.null(),
	handler: async (ctx, expected) => {
		const initial: CredentialConnection | null = await ctx.runMutation(
			internal.hubspotRecipients.start,
			expected
		);
		if (!initial) return null;
		let observed: Infer<typeof company> = null;
		let result: Infer<typeof outcome> = 'indeterminate',
			retryAfter = 15_000;
		try {
			const signal = AbortSignal.timeout(180_000);
			const connection = await connectionToken(ctx, initial, signal);
			observed = await resolveRecipient(ctx, connection, expected.dealId, signal);
			result = observed ? 'resolved' : 'empty';
		} catch (error) {
			if (error instanceof HubSpotError && error.status === 403) result = 'missing-capability';
			if (error instanceof HubSpotError) retryAfter = error.retryAfter;
		}
		await ctx.runMutation(internal.hubspotRecipients.commit, {
			target: expected,
			outcome: result,
			company: observed,
			retryAfter
		});
		return null;
	}
});
