import { ConvexError, v } from 'convex/values';
import { action, internalMutation, env } from './_generated/server';
import { internal } from './_generated/api';
import { requireMembership } from './auth';
import { sha256 } from './hubspotRecords';
import { tokenExchange } from './hubspotApi';
import { hubspotConnection } from './hubspotValidators';

export const reserve = internalMutation({
	args: { hash: v.string() },
	returns: v.null(),
	handler: async (ctx, { hash }) => {
		const access = await requireMembership(ctx);
		if (access.membership.role !== 'admin')
			throw new ConvexError('Only admins can install HubSpot.');
		const connection = await ctx.db
			.query('hubspotConnections')
			.withIndex('by_companyId', (q) => q.eq('companyId', access.companyId))
			.unique();
		await ctx.db.insert('hubspotOAuthStates', {
			hash,
			companyId: access.companyId,
			membershipId: access.membershipId,
			profileId: access.profile._id,
			generation: connection?.generation ?? 0,
			expiresAt: Date.now() + 10 * 60_000,
			claimed: false
		});
		return null;
	}
});
export const start = action({
	args: {},
	returns: v.object({ url: v.string(), state: v.string() }),
	handler: async (ctx): Promise<{ url: string; state: string }> => {
		if (
			!env.HUBSPOT_CLIENT_ID ||
			!env.HUBSPOT_CLIENT_SECRET ||
			!env.HUBSPOT_REDIRECT_URI ||
			!env.HUBSPOT_SCOPES ||
			env.HUBSPOT_ENABLED !== 'true'
		)
			throw new ConvexError('HubSpot installation is not configured yet.');
		const state = crypto.randomUUID() + crypto.randomUUID();
		await ctx.runMutation(internal.hubspotOAuth.reserve, { hash: await sha256(state) });
		const url = new URL('https://app.hubspot.com/oauth/authorize');
		url.search = new URLSearchParams({
			client_id: env.HUBSPOT_CLIENT_ID,
			redirect_uri: env.HUBSPOT_REDIRECT_URI,
			scope: env.HUBSPOT_SCOPES,
			state
		}).toString();
		return { url: url.toString(), state };
	}
});
export const claim = internalMutation({
	args: { hash: v.string() },
	returns: v.id('hubspotOAuthStates'),
	handler: async (ctx, { hash }) => {
		const access = await requireMembership(ctx);
		const state = await ctx.db
			.query('hubspotOAuthStates')
			.withIndex('by_hash', (q) => q.eq('hash', hash))
			.unique();
		if (
			!state ||
			state.claimed ||
			state.expiresAt < Date.now() ||
			state.membershipId !== access.membershipId ||
			state.profileId !== access.profile._id ||
			state.companyId !== access.companyId ||
			access.membership.role !== 'admin'
		)
			throw new ConvexError('Installation expired. Start again.');
		await ctx.db.patch('hubspotOAuthStates', state._id, { claimed: true });
		return state._id;
	}
});
export const commit = internalMutation({
	args: {
		stateId: v.id('hubspotOAuthStates'),
		accountId: v.string(),
		scopes: v.array(v.string()),
		tokens: hubspotConnection.pick('accessToken', 'refreshToken', 'expiresAt')
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx);
		const state = await ctx.db.get('hubspotOAuthStates', args.stateId);
		if (
			!state ||
			!state.claimed ||
			state.expiresAt < Date.now() ||
			state.membershipId !== access.membershipId ||
			state.companyId !== access.companyId ||
			access.membership.role !== 'admin'
		)
			throw new ConvexError('Installation expired. Start again.');
		const existing = await ctx.db
			.query('hubspotConnections')
			.withIndex('by_companyId', (q) => q.eq('companyId', access.companyId))
			.unique();
		if ((existing?.generation ?? 0) !== state.generation)
			throw new ConvexError('Another installation finished first. Reload to see its status.');
		if (existing && existing.accountId !== args.accountId)
			throw new ConvexError('Reconnect using the original HubSpot account.');
		const value = {
			companyId: access.companyId,
			accountId: args.accountId,
			scopes: args.scopes,
			...args.tokens,
			generation: state.generation + 1,
			installerId: access.profile._id,
			installedAt: Date.now(),
			status: 'connected' as const
		};
		if (existing) await ctx.db.replace('hubspotConnections', existing._id, value);
		else await ctx.db.insert('hubspotConnections', value);
		await ctx.db.delete('hubspotOAuthStates', state._id);
		return null;
	}
});
export const finish = action({
	args: { state: v.string(), code: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		if (args.state.length > 200 || args.code.length > 4096)
			throw new ConvexError('Invalid installation response.');
		const stateId = await ctx.runMutation(internal.hubspotOAuth.claim, {
			hash: await sha256(args.state)
		});
		const tokens = await tokenExchange({
			grant_type: 'authorization_code',
			code: args.code,
			redirect_uri: env.HUBSPOT_REDIRECT_URI ?? ''
		});
		// Do not log or return this response: it contains credentials. Introspection is server-only.
		const response = await fetch(
			`https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(tokens.accessToken)}`,
			{ signal: AbortSignal.timeout(20_000) }
		);
		if (!response.ok)
			throw new ConvexError('HubSpot could not verify this installation. Start again.');
		const info = await response.json();
		if (
			!info.hub_id ||
			!Array.isArray(info.scopes) ||
			!info.scopes.every((x: unknown) => typeof x === 'string')
		)
			throw new ConvexError('HubSpot returned an invalid installation.');
		const required = (env.HUBSPOT_SCOPES ?? '').split(/\s+/).filter(Boolean);
		if (required.some((s) => !info.scopes.includes(s)))
			throw new ConvexError('The installation is missing required permissions.');
		await ctx.runMutation(internal.hubspotOAuth.commit, {
			stateId,
			accountId: String(info.hub_id),
			scopes: info.scopes,
			tokens
		});
		return null;
	}
});
