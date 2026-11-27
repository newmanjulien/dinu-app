import { ConvexError, v } from 'convex/values';
import { env, internalMutation, internalQuery, query, type MutationCtx } from './_generated/server';
import { availableCompany, requireMembership } from './auth';
import {
	attachCredentials,
	connectionWithCredentials,
	credentialConnection,
	credentialFields,
	credentialsFor
} from './hubspotCredentials';
import { lifecycle, otherAttachments } from './hubspotInstallation';
import { quoteInstallationFor } from './hubspotQuotesInstallation';
import { hasQuoteScopes } from './hubspotQuoteValidators';
import { hubspotRemovalOutcome } from './hubspotValidators';

export const status = query({
	args: {},
	returns: v.object({
		quotes: v.object({
			installationId: v.union(v.id('hubspotQuoteInstallations'), v.null()),
			epoch: v.number(),
			installed: v.boolean(),
			connected: v.boolean(),
			enabled: v.boolean(),
			pushEnabled: v.boolean()
		}),
		configured: v.boolean(),
		enabled: v.boolean(),
		status: v.union(
			v.literal('uninstalled'),
			v.literal('connected'),
			v.literal('reconnect'),
			v.literal('uninstalling')
		),
		connectionId: v.union(v.id('hubspotConnections'), v.null()),
		accountId: v.union(v.string(), v.null()),
		installedAt: v.union(v.number(), v.null()),
		companyReadGranted: v.boolean(),
		shared: v.boolean(),
		removal: v.union(
			v.object({
				id: v.id('hubspotRemovals'),
				provider: hubspotRemovalOutcome,
				done: v.boolean(),
				blocking: v.boolean(),
				accountId: v.string()
			}),
			v.null()
		)
	}),
	handler: async (ctx) => {
		const access = await requireMembership(ctx);
		const [row, state, quotes] = await Promise.all([
			ctx.db
				.query('hubspotConnections')
				.withIndex('by_companyId', (q) => q.eq('companyId', access.companyId))
				.unique(),
			lifecycle(ctx, access.companyId),
			quoteInstallationFor(ctx, access.companyId)
		]);
		const [removal, shared] = await Promise.all([
			state?.removalId ? ctx.db.get('hubspotRemovals', state.removalId) : null,
			row ? otherAttachments(ctx, row.accountId, access.companyId) : false
		]);
		const provider = removal
			? await ctx.db.get('hubspotAccountRemovals', removal.providerId)
			: null;
		const installed = Boolean(
			quotes?.enabled &&
			row &&
			row.status !== 'retiring' &&
			quotes.connectionId === row._id &&
			quotes.accountId === row.accountId
		);
		return {
			quotes: {
				installationId: quotes?._id ?? null,
				epoch: quotes?.epoch ?? 0,
				installed,
				connected: Boolean(installed && row?.status === 'connected' && hasQuoteScopes(row.scopes)),
				enabled: env.HUBSPOT_QUOTES_ENABLED === 'true',
				pushEnabled: env.HUBSPOT_QUOTES_PUSH_ENABLED === 'true'
			},
			configured: Boolean(
				env.HUBSPOT_CLIENT_ID &&
				env.HUBSPOT_CLIENT_SECRET &&
				env.HUBSPOT_REDIRECT_URI &&
				env.HUBSPOT_SCOPES
			),
			enabled: env.HUBSPOT_ENABLED === 'true',
			status:
				row?.status === 'retiring' || (removal && !removal.done)
					? ('uninstalling' as const)
					: (row?.status ?? ('uninstalled' as const)),
			connectionId: row?._id ?? null,
			accountId: row?.accountId ?? null,
			installedAt: row?.installedAt ?? null,
			companyReadGranted: Boolean(row?.scopes.includes('crm.objects.companies.read')),
			shared,
			removal: removal
				? {
						id: removal._id,
						provider: provider?.provider ?? 'attention',
						done: removal.done,
						blocking: provider?.blocking ?? false,
						accountId: removal.accountId
					}
				: null
		};
	}
});
export const forMember = internalQuery({
	args: { membershipId: v.id('memberships') },
	returns: connectionWithCredentials,
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		const row = await ctx.db
			.query('hubspotConnections')
			.withIndex('by_companyId', (q) => q.eq('companyId', access.companyId))
			.unique();
		if (!row || row.status !== 'connected' || env.HUBSPOT_ENABLED !== 'true')
			throw new ConvexError('HubSpot is not connected. Ask an admin to install or reconnect it.');
		const connection = await attachCredentials(ctx, row);
		if (!connection) throw new ConvexError('HubSpot credentials are unavailable.');
		return connection;
	}
});
export const read = internalQuery({
	args: { id: v.id('hubspotConnections') },
	returns: v.union(connectionWithCredentials, v.null()),
	handler: async (ctx, { id }) => {
		const row = await credentialConnection(ctx, id);
		return row && (await availableCompany(ctx, row.companyId)) ? row : null;
	}
});
export const claimRefresh = internalMutation({
	args: { id: v.id('hubspotConnections'), generation: v.number(), claim: v.string() },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const row = await credentialConnection(ctx, args.id);
		if (
			!row ||
			row.generation !== args.generation ||
			row.status !== 'connected' ||
			!(await availableCompany(ctx, row.companyId))
		)
			return false;
		if (row.refreshUntil && row.refreshUntil > Date.now()) return false;
		const credentials = await credentialsFor(ctx, row._id);
		if (!credentials) return false;
		await ctx.db.patch('hubspotCredentials', credentials._id, {
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
		tokens: v.union(credentialFields.pick('accessToken', 'refreshToken', 'expiresAt'), v.null())
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const row = await credentialConnection(ctx, args.id);
		if (
			!row ||
			row.generation !== args.generation ||
			row.refreshClaim !== args.claim ||
			!(await availableCompany(ctx, row.companyId))
		)
			return false;
		const credentials = await credentialsFor(ctx, row._id);
		if (!credentials) return false;
		if (!args.tokens && row.status !== 'retiring')
			await ctx.db.patch('hubspotConnections', row._id, { status: 'reconnect' });
		await ctx.db.patch('hubspotCredentials', credentials._id, {
			...(args.tokens ?? {}),
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
	const row = await credentialConnection(ctx, args.id);
	if (
		!row ||
		row.status === 'retiring' ||
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
