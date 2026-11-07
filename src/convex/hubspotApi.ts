import { ConvexError } from 'convex/values';
import { RateLimiter } from '@convex-dev/rate-limiter';
import { components, internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { env, type ActionCtx } from './_generated/server';

const limiter = new RateLimiter(components.rateLimiter, {
	hubspot: { kind: 'token bucket', rate: 80, period: 10_000, capacity: 80 },
	search: { kind: 'token bucket', rate: 4, period: 1000, capacity: 4 }
});
export class HubSpotError extends Error {
	constructor(
		public status: number,
		public retryAfter = 60_000,
		public stage: 'not-attempted' | 'attempted' = 'attempted',
		public purpose: 'read' | 'create' = 'read'
	) {
		super(`HubSpot request failed (${status}).`);
	}
}
export async function tokenExchange(parameters: Record<string, string>) {
	if (!env.HUBSPOT_CLIENT_ID || !env.HUBSPOT_CLIENT_SECRET)
		throw new ConvexError('HubSpot installation is not configured.');
	const response = await fetch('https://api.hubapi.com/oauth/v1/token', {
		method: 'POST',
		body: new URLSearchParams({
			...parameters,
			client_id: env.HUBSPOT_CLIENT_ID,
			client_secret: env.HUBSPOT_CLIENT_SECRET
		}),
		signal: AbortSignal.timeout(20_000)
	});
	if (!response.ok) throw new HubSpotError(response.status);
	const data = await response.json();
	if (
		typeof data.access_token !== 'string' ||
		typeof data.refresh_token !== 'string' ||
		typeof data.expires_in !== 'number'
	)
		throw new HubSpotError(502);
	return {
		accessToken: data.access_token as string,
		refreshToken: data.refresh_token as string,
		expiresAt: Date.now() + data.expires_in * 1000
	};
}
export async function connectionToken(
	ctx: ActionCtx,
	connection: Doc<'hubspotConnections'>
): Promise<Doc<'hubspotConnections'>> {
	if (connection.status !== 'connected') throw new HubSpotError(401);
	if (connection.expiresAt > Date.now() + 60_000) return connection;
	const claim = crypto.randomUUID();
	if (
		!(await ctx.runMutation(internal.hubspotConnections.claimRefresh, {
			id: connection._id,
			generation: connection.generation,
			claim
		}))
	)
		throw new HubSpotError(429, 2000);
	try {
		const tokens = await tokenExchange({
			grant_type: 'refresh_token',
			refresh_token: connection.refreshToken
		});
		if (
			!(await ctx.runMutation(internal.hubspotConnections.refreshed, {
				id: connection._id,
				generation: connection.generation,
				claim,
				tokens
			}))
		)
			throw new HubSpotError(409, 2000);
		return { ...connection, ...tokens, generation: connection.generation + 1 };
	} catch (error) {
		if (error instanceof HubSpotError && [400, 401].includes(error.status))
			await ctx.runMutation(internal.hubspotConnections.refreshed, {
				id: connection._id,
				generation: connection.generation,
				claim,
				tokens: null
			});
		throw error;
	}
}
export async function hubspot(
	ctx: ActionCtx,
	connection: Doc<'hubspotConnections'>,
	path: string,
	init: RequestInit = {},
	search = false,
	purpose: 'read' | 'create' = 'read'
) {
	const quota = await limiter.limit(ctx, search ? 'search' : 'hubspot', {
		key: connection.accountId
	});
	if (!quota.ok) throw new HubSpotError(429, quota.retryAfter, 'not-attempted', purpose);
	const live = await ctx.runQuery(internal.hubspotConnections.read, { id: connection._id });
	if (!live || live.generation !== connection.generation || live.status !== 'connected')
		throw new HubSpotError(409, 2000, 'not-attempted', purpose);
	let response: Response;
	try {
		response = await fetch(`https://api.hubapi.com${path}`, {
			...init,
			headers: { ...init.headers, Authorization: `Bearer ${connection.accessToken}` },
			signal: AbortSignal.timeout(25_000)
		});
	} catch {
		throw new HubSpotError(0, 60_000, 'attempted', purpose);
	}
	if (response.status === 401)
		await ctx.runMutation(internal.hubspotConnections.reconnect, {
			id: connection._id,
			companyId: connection.companyId,
			accountId: connection.accountId,
			generation: connection.generation
		});
	if (!response.ok)
		throw new HubSpotError(
			response.status,
			Math.max(1000, Number(response.headers.get('retry-after') ?? 60) * 1000),
			'attempted',
			purpose
		);
	try {
		return await response.json();
	} catch {
		throw new HubSpotError(502, 60_000, 'attempted', purpose);
	}
}
/** Availability is object evidence, independent of a title's suitability for creation. */
export async function readDeal(ctx: ActionCtx, connection: Doc<'hubspotConnections'>, id: string) {
	if (!/^\d+$/.test(id)) throw new HubSpotError(502);
	let data;
	try {
		data = await hubspot(
			ctx,
			connection,
			`/crm/v3/objects/deals/${id}?properties=dealname&archived=false`
		);
	} catch (error) {
		if (error instanceof HubSpotError && error.status === 404 && error.stage === 'attempted')
			return null;
		throw error;
	}
	if (!data || String(data.id) !== id) throw new HubSpotError(502);
	return data.archived === true ? null : data;
}
export async function resolveDeal(
	ctx: ActionCtx,
	connection: Doc<'hubspotConnections'>,
	id: string
): Promise<{ id: string; name: string }> {
	if (!/^\d+$/.test(id)) throw new ConvexError('Choose a valid HubSpot deal.');
	const data = await readDeal(ctx, connection, id);
	if (!data || typeof data.properties?.dealname !== 'string' || !data.properties.dealname.length)
		throw new ConvexError('This deal is unavailable. Choose another deal.');
	// Preserve the exact provider title without accepting unbounded property data.
	if (new TextEncoder().encode(data.properties.dealname).length > 256 * 1024)
		throw new ConvexError('This HubSpot deal name exceeds the supported size.');
	return { id: String(data.id), name: data.properties.dealname };
}
