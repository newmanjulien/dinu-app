import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import { action, env, internalMutation } from './_generated/server';
import { requireMembership, requirePermission } from './auth';
import { tokenExchange } from './hubspotApi';
import { credentialFields, credentialsFor } from './hubspotCredentials';
import { portalLifecycle, requireInstallAllowed } from './hubspotInstallation';
import { quoteInstallationFor } from './hubspotQuotesInstallation';
import { hasQuoteScopes, oauthPurpose, quoteScopes } from './hubspotQuoteValidators';
import { sha256 } from './operationReceipts';
import { permissionsForRole } from './permissions';

export const reserve = internalMutation({
	args: { hash: v.string(), purpose: v.optional(oauthPurpose) },
	returns: v.null(),
	handler: async (ctx, { hash, purpose = 'base' }) => {
		const access = await requirePermission(ctx, 'manageIntegrations');
		const state = await requireInstallAllowed(ctx, access.companyId);
		const connection = await ctx.db
			.query('hubspotConnections')
			.withIndex('by_companyId', (q) => q.eq('companyId', access.companyId))
			.unique();
		const quotes = await quoteInstallationFor(ctx, access.companyId);
		if (
			purpose === 'quotes' &&
			(!connection || connection.status !== 'connected' || env.HUBSPOT_QUOTES_ENABLED !== 'true')
		)
			throw new ConvexError(
				'Connect the normal HubSpot integration before installing HubSpot Quotes.'
			);
		await ctx.db.insert('hubspotOAuthStates', {
			hash,
			purpose,
			...(purpose === 'quotes' && connection
				? {
						quoteEpoch: quotes?.epoch ?? 0,
						expectedConnectionId: connection._id,
						expectedAccountId: connection.accountId
					}
				: {}),
			companyId: access.companyId,
			membershipId: access.membershipId,
			profileId: access.profile._id,
			generation: connection ? ((await credentialsFor(ctx, connection._id))?.generation ?? 0) : 0,
			lifecycleVersion: state?.version ?? 0,
			expiresAt: Date.now() + 10 * 60_000,
			claimed: false
		});
		return null;
	}
});
export const start = action({
	args: { purpose: v.optional(oauthPurpose) },
	returns: v.object({ url: v.string(), state: v.string() }),
	handler: async (ctx, { purpose = 'base' }): Promise<{ url: string; state: string }> => {
		if (
			!env.HUBSPOT_CLIENT_ID ||
			!env.HUBSPOT_CLIENT_SECRET ||
			!env.HUBSPOT_REDIRECT_URI ||
			!env.HUBSPOT_SCOPES ||
			env.HUBSPOT_ENABLED !== 'true'
		)
			throw new ConvexError('HubSpot installation is not configured yet.');
		const state = crypto.randomUUID() + crypto.randomUUID();
		await ctx.runMutation(internal.hubspotOAuth.reserve, { hash: await sha256(state), purpose });
		const url = new URL('https://app.hubspot.com/oauth/authorize');
		url.search = new URLSearchParams({
			client_id: env.HUBSPOT_CLIENT_ID,
			redirect_uri: env.HUBSPOT_REDIRECT_URI,
			scope: [env.HUBSPOT_SCOPES, ...(purpose === 'quotes' ? quoteScopes : [])].join(' '),
			state
		}).toString();
		return { url: url.toString(), state };
	}
});
export const claim = internalMutation({
	args: { hash: v.string(), purpose: v.optional(oauthPurpose) },
	returns: v.id('hubspotOAuthStates'),
	handler: async (ctx, { hash, purpose = 'base' }) => {
		const access = await requireMembership(ctx);
		const state = await ctx.db
			.query('hubspotOAuthStates')
			.withIndex('by_hash', (q) => q.eq('hash', hash))
			.unique();
		if (
			!state ||
			(state.purpose ?? 'base') !== purpose ||
			state.claimed ||
			state.expiresAt < Date.now() ||
			state.membershipId !== access.membershipId ||
			state.profileId !== access.profile._id ||
			state.companyId !== access.companyId ||
			!permissionsForRole(access.membership.role, access.isOwner).manageIntegrations
		)
			throw new ConvexError('Installation expired. Start again.');
		const current = await requireInstallAllowed(ctx, access.companyId);
		if ((state.lifecycleVersion ?? 0) !== (current?.version ?? 0))
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
		tokens: credentialFields.pick('accessToken', 'refreshToken', 'expiresAt')
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx);
		const state = await ctx.db.get('hubspotOAuthStates', args.stateId);
		if (
			!state ||
			!state.claimed ||
			state.expiresAt < Date.now() ||
			state.membershipId !== access.membershipId ||
			state.profileId !== access.profile._id ||
			state.companyId !== access.companyId ||
			!permissionsForRole(access.membership.role, access.isOwner).manageIntegrations
		)
			throw new ConvexError('Installation expired. Start again.');
		const current = await requireInstallAllowed(ctx, access.companyId, args.accountId);
		const portal = await portalLifecycle(ctx, args.accountId);
		if (portal?.uninstalledAt && portal.uninstalledAt >= state._creationTime)
			throw new ConvexError('HubSpot was uninstalled while connecting. Start a new installation.');
		const existing = await ctx.db
			.query('hubspotConnections')
			.withIndex('by_companyId', (q) => q.eq('companyId', access.companyId))
			.unique();
		if (
			(existing ? ((await credentialsFor(ctx, existing._id))?.generation ?? 0) : 0) !==
			state.generation
		)
			throw new ConvexError('Another installation finished first. Reload to see its status.');
		if ((state.lifecycleVersion ?? 0) !== (current?.version ?? 0))
			throw new ConvexError('Installation expired. Start again.');
		if (existing && existing.accountId !== args.accountId)
			throw new ConvexError('Reconnect using the original HubSpot account.');
		const quotes = await quoteInstallationFor(ctx, access.companyId);
		if (
			state.purpose === 'quotes' &&
			(!existing ||
				existing._id !== state.expectedConnectionId ||
				existing.status !== 'connected' ||
				args.accountId !== state.expectedAccountId ||
				(quotes?.epoch ?? 0) !== state.quoteEpoch ||
				env.HUBSPOT_QUOTES_ENABLED !== 'true')
		)
			throw new ConvexError('HubSpot Quotes installation expired. Start again.');
		const value = {
			companyId: access.companyId,
			accountId: args.accountId,
			scopes: args.scopes,
			installerId: access.profile._id,
			// Credential/cache freshness; immutable installation identity begins at _creationTime.
			installedAt: Date.now(),
			status: 'connected' as const
		};
		if (existing?.status === 'retiring') throw new ConvexError('HubSpot is being uninstalled.');
		const connectionId = existing?._id ?? (await ctx.db.insert('hubspotConnections', value));
		if (existing) await ctx.db.replace('hubspotConnections', existing._id, value);
		const credentials = existing ? await credentialsFor(ctx, existing._id) : null;
		const tokens = {
			...args.tokens,
			generation: state.generation + 1,
			refreshClaim: undefined,
			refreshUntil: undefined
		};
		if (credentials) await ctx.db.patch('hubspotCredentials', credentials._id, tokens);
		else
			await ctx.db.insert('hubspotCredentials', {
				companyId: access.companyId,
				connectionId,
				...tokens
			});
		const quoteGranted = hasQuoteScopes(args.scopes);
		if (state.purpose === 'quotes' && quoteGranted) {
			const quoteValue = {
				companyId: access.companyId,
				connectionId,
				accountId: args.accountId,
				enabled: true,
				epoch: (quotes?.epoch ?? 0) + 1,
				installedAt: Date.now(),
				installerId: access.profile._id
			};
			if (quotes) await ctx.db.replace('hubspotQuoteInstallations', quotes._id, quoteValue);
			else await ctx.db.insert('hubspotQuoteInstallations', quoteValue);
		}
		// Invalidates other pending callbacks, including generation-zero first installs.
		if (current)
			await ctx.db.patch('hubspotLifecycles', current._id, {
				version: current.version + 1,
				removalId: undefined
			});
		else await ctx.db.insert('hubspotLifecycles', { companyId: access.companyId, version: 1 });
		await ctx.db.delete('hubspotOAuthStates', state._id);
		return state.purpose !== 'quotes' || quoteGranted;
	}
});
export const finish = action({
	args: { state: v.string(), code: v.string(), purpose: v.optional(oauthPurpose) },
	returns: v.boolean(),
	handler: async (ctx, args): Promise<boolean> => {
		if (args.state.length > 200 || args.code.length > 4096)
			throw new ConvexError('Invalid installation response.');
		const stateId = await ctx.runMutation(internal.hubspotOAuth.claim, {
			hash: await sha256(args.state),
			purpose: args.purpose ?? 'base'
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
		const raw: unknown = await response.json();
		if (!raw || typeof raw !== 'object')
			throw new ConvexError('HubSpot returned an invalid installation.');
		const info = raw as Record<string, unknown>;
		if (
			!/^\d+$/.test(String(info.hub_id)) ||
			!Array.isArray(info.scopes) ||
			!info.scopes.every((x: unknown) => typeof x === 'string')
		)
			throw new ConvexError('HubSpot returned an invalid installation.');
		const scopes = info.scopes as string[];
		const required = [
			...(env.HUBSPOT_SCOPES ?? '').split(/\s+/).filter(Boolean),
			...(args.purpose === 'quotes' ? quoteScopes : [])
		];
		if (required.some((s) => !scopes.includes(s)))
			throw new ConvexError('The installation is missing required permissions.');
		return ctx.runMutation(internal.hubspotOAuth.commit, {
			stateId,
			accountId: String(info.hub_id),
			scopes: info.scopes as string[],
			tokens
		});
	}
});
