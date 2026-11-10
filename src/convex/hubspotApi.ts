import { ConvexError } from 'convex/values';
import { RateLimiter } from '@convex-dev/rate-limiter';
import { components, internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { env, type ActionCtx } from './_generated/server';

const limiter = new RateLimiter(components.rateLimiter, {
	hubspot: { kind: 'token bucket', rate: 80, period: 10_000, capacity: 80 },
	search: { kind: 'token bucket', rate: 4, period: 1000, capacity: 4 }
});
export const hubspotErrorIdentifier = (value: unknown) =>
	typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/u.test(value) ? value : undefined;

export class HubSpotError extends Error {
	constructor(
		public status: number,
		public retryAfter = 60_000,
		public stage: 'not-attempted' | 'attempted' = 'attempted',
		public purpose: 'read' | 'create' = 'read',
		public detail?: { category?: string; code?: string; correlationId?: string }
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
		!data ||
		typeof data !== 'object' ||
		Array.isArray(data) ||
		!('access_token' in data) ||
		!('refresh_token' in data) ||
		!('expires_in' in data) ||
		typeof data.access_token !== 'string' ||
		typeof data.refresh_token !== 'string' ||
		typeof data.expires_in !== 'number'
	)
		throw new HubSpotError(502);
	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
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
): Promise<unknown> {
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
	if (!response.ok) {
		// Retain only bounded identifiers, never provider messages, context or request content.
		let detail: HubSpotError['detail'];
		try {
			const raw: unknown = await response.json();
			if (raw && typeof raw === 'object') {
				const data = raw as Record<string, unknown>;
				detail = {
					category: hubspotErrorIdentifier(data.category),
					code: hubspotErrorIdentifier(data.code),
					correlationId: hubspotErrorIdentifier(data.correlationId)
				};
			}
		} catch {
			/* Error payloads are optional. */
		}
		throw new HubSpotError(
			response.status,
			Math.min(
				300_000,
				Math.max(1000, Number(response.headers.get('retry-after') ?? 60) * 1000 || 60_000)
			),
			'attempted',
			purpose,
			detail
		);
	}
	try {
		const data: unknown = await response.json();
		return data;
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
	const deal = record(data);
	if (
		objectId(deal.id) !== id ||
		(deal.archived !== undefined && typeof deal.archived !== 'boolean')
	)
		throw new HubSpotError(502);
	return deal.archived === true ? null : { id, properties: record(deal.properties) };
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
	return { id: data.id, name: data.properties.dealname };
}

export function record(
	value: unknown,
	purpose: 'read' | 'create' = 'read'
): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new HubSpotError(502, 60_000, 'attempted', purpose);
	return value as Record<string, unknown>;
}

export function objectId(value: unknown, purpose: 'read' | 'create' = 'read'): string {
	const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
	if (typeof id !== 'string' || !/^\d{1,100}$/u.test(id))
		throw new HubSpotError(502, 60_000, 'attempted', purpose);
	return id;
}

/** Optional display metadata; failures never establish that the linked deal is unavailable. */
export async function resolveRecipient(
	ctx: ActionCtx,
	connection: Doc<'hubspotConnections'>,
	dealId: string
): Promise<{ companyId: string; name: string } | null> {
	objectId(dealId);
	const companies = new Set<string>();
	const primary = new Set<string>();
	const cursors = new Set<string>();
	let after: string | undefined;
	for (let page = 0; page < 5; page++) {
		const data = record(
			await hubspot(
				ctx,
				connection,
				`/crm/objects/2026-09/deals/${dealId}/associations/companies?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`
			)
		);
		if (!Array.isArray(data.results) || data.results.length > 100) throw new HubSpotError(502);
		for (const value of data.results) {
			const association = record(value);
			const id = objectId(association.toObjectId);
			if (!Array.isArray(association.associationTypes)) throw new HubSpotError(502);
			companies.add(id);
			for (const value of association.associationTypes) {
				const type = record(value);
				if (
					typeof type.category !== 'string' ||
					!['HUBSPOT_DEFINED', 'INTEGRATOR_DEFINED', 'USER_DEFINED', 'WORK'].includes(
						type.category
					) ||
					typeof type.typeId !== 'number' ||
					!Number.isSafeInteger(type.typeId)
				)
					throw new HubSpotError(502);
				if (type.category === 'HUBSPOT_DEFINED' && type.typeId === 5) primary.add(id);
			}
		}
		const paging = data.paging === undefined ? undefined : record(data.paging);
		if (paging?.next === undefined) break;
		const next = record(paging.next).after;
		const cursor = typeof next === 'number' && Number.isSafeInteger(next) ? String(next) : next;
		if (
			typeof cursor !== 'string' ||
			!cursor.length ||
			cursor.length > 2048 ||
			cursors.has(cursor) ||
			page === 4
		)
			throw new HubSpotError(502);
		cursors.add(cursor);
		after = cursor;
	}
	const companyId =
		primary.size === 1
			? primary.values().next().value
			: primary.size === 0 && companies.size === 1
				? companies.values().next().value
				: undefined;
	if (!companyId) return null;
	const company = record(
		await hubspot(
			ctx,
			connection,
			`/crm/objects/2026-09/companies/${companyId}?properties=name&archived=false`
		)
	);
	if (objectId(company.id) !== companyId || typeof company.archived !== 'boolean')
		throw new HubSpotError(502);
	if (company.archived) return null;
	const name = record(company.properties).name;
	if (name === undefined || name === null || name === '') return null;
	if (typeof name !== 'string' || new TextEncoder().encode(name).length > 256 * 1024)
		throw new HubSpotError(502);
	return name.trim() ? { companyId, name: name.trim() } : null;
}

export function nextCursor(data: Record<string, unknown>): string | null {
	const paging = data.paging == null ? undefined : record(data.paging);
	const next = paging?.next == null ? undefined : record(paging.next);
	const after = next?.after;
	if (after == null) return null;
	const cursor = typeof after === 'number' && Number.isSafeInteger(after) ? String(after) : after;
	if (typeof cursor !== 'string' || !cursor.length || cursor.length > 2048)
		throw new HubSpotError(502);
	return cursor;
}
