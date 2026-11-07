import { ConvexError, v } from 'convex/values';
import { internalMutation, internalQuery, query, env, type MutationCtx } from './_generated/server';
import { availableCompany, requireMembership } from './auth';
import { hubspotConnection } from './hubspotValidators';
import schema from './schema';

export const status = query({
	args: { membershipId: v.id('memberships') },
	returns: v.object({
		configured: v.boolean(),
		enabled: v.boolean(),
		status: v.union(v.literal('uninstalled'), v.literal('connected'), v.literal('reconnect')),
		accountId: v.union(v.string(), v.null()),
		installedAt: v.union(v.number(), v.null())
	}),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		const row = await ctx.db
			.query('hubspotConnections')
			.withIndex('by_companyId', (q) => q.eq('companyId', access.companyId))
			.unique();
		return {
			configured: Boolean(
				env.HUBSPOT_CLIENT_ID &&
				env.HUBSPOT_CLIENT_SECRET &&
				env.HUBSPOT_REDIRECT_URI &&
				env.HUBSPOT_SCOPES
			),
			enabled: env.HUBSPOT_ENABLED === 'true',
			status: row?.status ?? ('uninstalled' as const),
			accountId: row?.accountId ?? null,
			installedAt: row?.installedAt ?? null
		};
	}
});
export const forMember = internalQuery({
	args: { membershipId: v.id('memberships') },
	returns: schema.doc('hubspotConnections'),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		const row = await ctx.db
			.query('hubspotConnections')
			.withIndex('by_companyId', (q) => q.eq('companyId', access.companyId))
			.unique();
		if (!row || row.status !== 'connected' || env.HUBSPOT_ENABLED !== 'true')
			throw new ConvexError('HubSpot is not connected. Ask an admin to install or reconnect it.');
		return row;
	}
});
export const read = internalQuery({
	args: { id: v.id('hubspotConnections') },
	returns: v.union(schema.doc('hubspotConnections'), v.null()),
	handler: async (ctx, { id }) => {
		const row = await ctx.db.get('hubspotConnections', id);
		return row && (await availableCompany(ctx, row.companyId)) ? row : null;
	}
});
export const claimRefresh = internalMutation({
	args: { id: v.id('hubspotConnections'), generation: v.number(), claim: v.string() },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const row = await ctx.db.get('hubspotConnections', args.id);
		if (
			!row ||
			row.generation !== args.generation ||
			row.status !== 'connected' ||
			!(await availableCompany(ctx, row.companyId))
		)
			return false;
		if (row.refreshUntil && row.refreshUntil > Date.now()) return false;
		await ctx.db.patch('hubspotConnections', row._id, {
			refreshClaim: args.claim,
			refreshUntil: Date.now() + 60_000
		});
		return true;
	}
});
export const refreshed = internalMutation({
	args: {
		id: v.id('hubspotConnections'),
		generation: v.number(),
		claim: v.string(),
		tokens: v.union(hubspotConnection.pick('accessToken', 'refreshToken', 'expiresAt'), v.null())
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const row = await ctx.db.get('hubspotConnections', args.id);
		if (
			!row ||
			row.generation !== args.generation ||
			row.refreshClaim !== args.claim ||
			!(await availableCompany(ctx, row.companyId))
		)
			return false;
		await ctx.db.patch('hubspotConnections', row._id, {
			...(args.tokens ?? { status: 'reconnect' as const }),
			generation: row.generation + 1,
			refreshClaim: undefined,
			refreshUntil: undefined
		});
		return true;
	}
});

/** A stale provider observation cannot downgrade rotated/reconnected credentials. */
export async function requireReconnect(
	ctx: MutationCtx,
	args: {
		id: import('./_generated/dataModel').Id<'hubspotConnections'>;
		companyId: import('./_generated/dataModel').Id<'company'>;
		accountId: string;
		generation: number;
	}
) {
	const row = await ctx.db.get('hubspotConnections', args.id);
	if (
		!row ||
		row.companyId !== args.companyId ||
		row.accountId !== args.accountId ||
		row.generation !== args.generation ||
		!(await availableCompany(ctx, row.companyId))
	)
		return false;
	await ctx.db.patch('hubspotConnections', row._id, { status: 'reconnect' });
	return true;
}
export const reconnect = internalMutation({
	args: {
		id: v.id('hubspotConnections'),
		companyId: v.id('company'),
		accountId: v.string(),
		generation: v.number()
	},
	returns: v.boolean(),
	handler: requireReconnect
});
