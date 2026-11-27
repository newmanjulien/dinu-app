import { ConvexError, v, type Infer } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { env, internalAction, internalMutation } from './_generated/server';
import { portalLifecycle } from './hubspotInstallation';
import { retireInstallation } from './hubspotUninstall';
import schema from './schema';

const journalEvent = v.object({
	accountId: v.string(),
	action: v.union(v.literal('APP_INSTALL'), v.literal('APP_UNINSTALL')),
	occurredAt: v.number()
});
const replayWindow = 3 * 24 * 60 * 60_000;
const lease = 150_000;

async function appToken(scopes: string) {
	if (!env.HUBSPOT_CLIENT_ID || !env.HUBSPOT_CLIENT_SECRET || !env.HUBSPOT_APP_ID)
		throw new Error('HubSpot Journal app credentials are not configured');
	if (!/^\d+$/.test(env.HUBSPOT_APP_ID)) throw new Error('HubSpot Journal app ID must be numeric');
	const response = await fetch('https://api.hubapi.com/oauth/2026-09/token', {
		method: 'POST',
		body: new URLSearchParams({
			grant_type: 'client_credentials',
			client_id: env.HUBSPOT_CLIENT_ID,
			client_secret: env.HUBSPOT_CLIENT_SECRET,
			scope: scopes
		}),
		signal: AbortSignal.timeout(20_000)
	});
	if (!response.ok) throw new Error(`HubSpot Journal authentication failed (${response.status})`);
	const data = object(await response.json());
	if (typeof data.access_token !== 'string')
		throw new Error('Invalid HubSpot Journal token response');
	return data.access_token;
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid HubSpot Journal response');
	return value as Record<string, unknown>;
}
async function request(token: string, path: string, body?: unknown) {
	const response = await fetch(`https://api.hubapi.com${path}`, {
		method: body ? 'POST' : 'GET',
		headers: {
			Authorization: `Bearer ${token}`,
			...(body ? { 'Content-Type': 'application/json' } : {})
		},
		...(body ? { body: JSON.stringify(body) } : {}),
		signal: AbortSignal.timeout(20_000)
	});
	if (!response.ok) throw new Error(`HubSpot Journal request failed (${response.status})`);
	return object(await response.json());
}

/** Run once in the authorized development/release setup after verifying app entitlement. */
export const configure = internalAction({
	args: {},
	returns: v.null(),
	handler: async (): Promise<null> => {
		const token = await appToken('developer.webhooks_journal.subscriptions.write');
		for (const eventTypeId of ['4-1909196', '4-1916193']) {
			const subscription = await request(token, '/webhooks-journal/subscriptions/2026-09', {
				subscriptionType: 'APP_LIFECYCLE_EVENT',
				eventTypeId,
				properties: ['hs_app_id', 'hs_app_install_level']
			});
			if (String(subscription.appId) !== env.HUBSPOT_APP_ID)
				throw new Error('HubSpot Journal app ID does not match its credentials');
		}
		return null;
	}
});

/** No action or external request on idle installations. */
export const probe = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		if (
			env.HUBSPOT_JOURNAL_ENABLED === 'true' &&
			(await ctx.db.query('hubspotConnections').first())
		)
			await ctx.scheduler.runAfter(0, internal.hubspotJournal.poll, {});
		return null;
	}
});

export const claim = internalMutation({
	args: { claim: v.string() },
	returns: v.union(schema.doc('hubspotJournal'), v.null()),
	handler: async (ctx, args) => {
		if (
			env.HUBSPOT_JOURNAL_ENABLED !== 'true' ||
			!(await ctx.db.query('hubspotConnections').first())
		)
			return null;
		let state = await ctx.db
			.query('hubspotJournal')
			.withIndex('by_name', (q) => q.eq('name', 'lifecycle'))
			.unique();
		if (!state) {
			const id = await ctx.db.insert('hubspotJournal', {
				name: 'lifecycle',
				position: 0,
				checkedAt: Date.now()
			});
			state = (await ctx.db.get('hubspotJournal', id))!;
		}
		if ((state.leaseUntil ?? 0) > Date.now()) return null;
		if (state.offset && state.checkedAt + replayWindow < Date.now()) {
			await ctx.db.patch('hubspotJournal', state._id, {
				diagnostic: 'Journal replay window exceeded; operator reconciliation required'
			});
			console.error('HubSpot lifecycle Journal exceeded its three-day replay window');
			return null;
		}
		await ctx.db.patch('hubspotJournal', state._id, {
			claim: args.claim,
			leaseUntil: Date.now() + lease
		});
		return state;
	}
});

export const consume = internalMutation({
	args: {
		claim: v.string(),
		offset: v.string(),
		position: v.number(),
		events: v.array(journalEvent),
		done: v.boolean()
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const state = await ctx.db
			.query('hubspotJournal')
			.withIndex('by_name', (q) => q.eq('name', 'lifecycle'))
			.unique();
		if (!state || state.claim !== args.claim || (state.leaseUntil ?? 0) <= Date.now()) return false;
		if (
			args.events.length > 25 ||
			args.position !== state.position ||
			(state.processingOffset && state.processingOffset !== args.offset)
		)
			throw new ConvexError('Journal checkpoint changed.');
		for (const event of args.events) {
			const portal = await portalLifecycle(ctx, event.accountId);
			const field = event.action === 'APP_INSTALL' ? 'installedAt' : 'uninstalledAt';
			if (portal && (portal[field] ?? 0) >= event.occurredAt) continue;
			if (portal)
				await ctx.db.patch('hubspotPortalLifecycle', portal._id, { [field]: event.occurredAt });
			else
				await ctx.db.insert('hubspotPortalLifecycle', {
					accountId: event.accountId,
					[field]: event.occurredAt
				});
			if (event.action === 'APP_UNINSTALL')
				await ctx.scheduler.runAfter(0, internal.hubspotJournal.retirePortal, {
					accountId: event.accountId,
					occurredAt: event.occurredAt,
					cursor: null
				});
		}
		await ctx.db.patch(
			'hubspotJournal',
			state._id,
			args.done
				? {
						offset: args.offset,
						processingOffset: undefined,
						position: 0,
						checkedAt: Date.now(),
						diagnostic: undefined
					}
				: { processingOffset: args.offset, position: args.position + args.events.length }
		);
		return true;
	}
});

export const retirePortal = internalMutation({
	args: { accountId: v.string(), occurredAt: v.number(), cursor: v.union(v.string(), v.null()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const portal = await portalLifecycle(ctx, args.accountId);
		if (!portal || portal.uninstalledAt !== args.occurredAt) return null;
		const page = await ctx.db
			.query('hubspotConnections')
			.withIndex('by_accountId_and_status', (q) => q.eq('accountId', args.accountId))
			.paginate({ cursor: args.cursor, numItems: 25 });
		for (const connection of page.page) {
			if (connection.status === 'retiring') continue;
			// ID birth is immutable; installedAt changes on credential reconnect/cache refresh.
			if (connection._creationTime < args.occurredAt)
				await retireInstallation(ctx, connection, 'hubspot');
			else if (!(
				connection._creationTime > args.occurredAt &&
				(portal.installedAt ?? 0) > args.occurredAt &&
				connection._creationTime > (portal.installedAt ?? 0)
			)) {
				// No provider incarnation ID: don't remove a possibly newer local installation.
				await ctx.db.patch('hubspotConnections', connection._id, {
					status: 'reconnect'
				});
				await ctx.db.patch('hubspotPortalLifecycle', portal._id, {
					diagnostic: 'Uninstall/install chronology is ambiguous; verify the current installation'
				});
			}
		}
		if (!page.isDone)
			await ctx.scheduler.runAfter(0, internal.hubspotJournal.retirePortal, {
				...args,
				cursor: page.continueCursor
			});
		else
			await ctx.scheduler.runAfter(0, internal.hubspotJournal.confirmRemovals, {
				accountId: args.accountId,
				occurredAt: args.occurredAt,
				cursor: null
			});
		return null;
	}
});

export const confirmRemovals = internalMutation({
	args: { accountId: v.string(), occurredAt: v.number(), cursor: v.union(v.string(), v.null()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const portal = await portalLifecycle(ctx, args.accountId);
		if (
			!portal ||
			portal.uninstalledAt !== args.occurredAt ||
			(portal.installedAt ?? 0) >= args.occurredAt
		)
			return null;
		const page = await ctx.db
			.query('hubspotAccountRemovals')
			.withIndex('by_accountId_and_blocking', (q) =>
				q.eq('accountId', args.accountId).eq('blocking', true)
			)
			.paginate({ cursor: args.cursor, numItems: 25 });
		for (const removal of page.page) {
			if (removal.createdAt > args.occurredAt || (removal.deleteStartedAt ?? 0) > args.occurredAt)
				continue;
			await ctx.db.patch('hubspotAccountRemovals', removal._id, {
				provider: 'confirmed',
				diagnostic: 'HubSpot lifecycle Journal confirmed app removal'
			});
			// Recovery preserves the dispatch reserve even when the tenant has disappeared.
			await ctx.scheduler.runAfter(0, internal.hubspotUninstall.recoverProvider, {
				id: removal._id
			});
		}
		if (!page.isDone)
			await ctx.scheduler.runAfter(0, internal.hubspotJournal.confirmRemovals, {
				...args,
				cursor: page.continueCursor
			});
		return null;
	}
});

export const release = internalMutation({
	args: { claim: v.string(), diagnostic: v.optional(v.string()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const state = await ctx.db
			.query('hubspotJournal')
			.withIndex('by_name', (q) => q.eq('name', 'lifecycle'))
			.unique();
		if (state?.claim === args.claim)
			await ctx.db.patch('hubspotJournal', state._id, {
				claim: undefined,
				leaseUntil: undefined,
				diagnostic: args.diagnostic,
				...(!args.diagnostic ? { checkedAt: Date.now() } : {})
			});
		return null;
	}
});

/** Operator-only: establish a verified recovery position after reconciling a replay gap. */
export const reset = internalMutation({
	args: { offset: v.union(v.string(), v.null()), evidence: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		if (
			!args.evidence.trim() ||
			args.evidence.length > 2000 ||
			(args.offset && args.offset.length > 200)
		)
			throw new ConvexError('Provide a verified Journal recovery position and evidence reference.');
		const state = await ctx.db
			.query('hubspotJournal')
			.withIndex('by_name', (q) => q.eq('name', 'lifecycle'))
			.unique();
		if (!state) throw new ConvexError('The Journal has not started.');
		await ctx.db.patch('hubspotJournal', state._id, {
			offset: args.offset ?? undefined,
			processingOffset: undefined,
			position: 0,
			claim: undefined,
			leaseUntil: undefined,
			checkedAt: Date.now(),
			diagnostic: `Operator reconciled Journal history: ${args.evidence}`
		});
		return null;
	}
});

async function readEvents(url: string, offset: string): Promise<Infer<typeof journalEvent>[]> {
	if (new URL(url).protocol !== 'https:') throw new Error('Invalid Journal download URL');
	// Never forward app credentials to the pre-signed storage URL.
	const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
	if (!response.ok || !response.body) throw new Error('Unable to download Journal entry');
	const reader = response.body.getReader(),
		chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > 4 * 1024 * 1024) throw new Error('Journal entry exceeds the processing envelope');
			chunks.push(part.value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const part of chunks) {
		bytes.set(part, at);
		at += part.byteLength;
	}
	const file = object(JSON.parse(new TextDecoder().decode(bytes)));
	if (
		file.offset !== offset ||
		!Array.isArray(file.journalEvents) ||
		file.journalEvents.length > 8192
	)
		throw new Error('Invalid Journal event envelope');
	const events: Infer<typeof journalEvent>[] = [];
	for (const value of file.journalEvents) {
		const event = object(value);
		if (event.type !== 'app_lifecycle_event') continue;
		const properties = object(event.properties);
		if (
			String(properties.hs_app_id) !== env.HUBSPOT_APP_ID ||
			properties.hs_app_install_level !== 'PORTAL'
		)
			continue;
		if (event.action !== 'APP_INSTALL' && event.action !== 'APP_UNINSTALL')
			throw new Error('Invalid app lifecycle action');
		if (event.eventTypeId !== (event.action === 'APP_INSTALL' ? '4-1909196' : '4-1916193'))
			throw new Error('Invalid app lifecycle event type');
		const occurredAt = typeof event.occurredAt === 'string' ? Date.parse(event.occurredAt) : NaN;
		const accountId = String(event.portalId);
		if (
			!/^\d+$/.test(accountId) ||
			!Number.isFinite(occurredAt) ||
			occurredAt > Date.now() + 60_000
		)
			throw new Error('Invalid app lifecycle identity');
		events.push({ accountId, occurredAt, action: event.action });
	}
	return events;
}

export const poll = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx): Promise<null> => {
		if (env.HUBSPOT_JOURNAL_ENABLED !== 'true') return null;
		const claim = crypto.randomUUID();
		const state: Doc<'hubspotJournal'> | null = await ctx.runMutation(
			internal.hubspotJournal.claim,
			{ claim }
		);
		if (!state) return null;
		try {
			const token = await appToken('developer.webhooks_journal.read');
			const path = state.offset
				? `batch/${encodeURIComponent(state.offset)}/next/1`
				: 'batch/earliest/1';
			const batch = await request(token, `/webhooks-journal/journal/2026-09/${path}`);
			if (
				batch.status !== 'COMPLETE' ||
				batch.numErrors !== 0 ||
				!Array.isArray(batch.results) ||
				batch.results.length > 1
			)
				throw new Error('Journal retrieval incomplete; checkpoint retained');
			if (batch.results.length) {
				const entry = object(batch.results[0]);
				if (
					typeof entry.url !== 'string' ||
					typeof entry.currentOffset !== 'string' ||
					entry.currentOffset.length > 200 ||
					entry.currentOffset === state.offset ||
					(state.processingOffset && state.processingOffset !== entry.currentOffset)
				)
					throw new Error('Journal offset changed; checkpoint retained');
				const events = await readEvents(entry.url, entry.currentOffset);
				if (state.position > events.length) throw new Error('Journal event position changed');
				for (let position = state.position; ; position += 25) {
					const done = position + 25 >= events.length;
					if (
						!(await ctx.runMutation(internal.hubspotJournal.consume, {
							claim,
							offset: entry.currentOffset,
							position,
							events: events.slice(position, position + 25),
							done
						}))
					)
						return null;
					if (done) break;
				}
			}
			await ctx.runMutation(internal.hubspotJournal.release, { claim });
			if (batch.results.length) await ctx.scheduler.runAfter(0, internal.hubspotJournal.poll, {});
		} catch (error) {
			const diagnostic =
				error instanceof Error && error.name === 'Error'
					? error.message
					: 'Journal transport or response failed';
			console.error('HubSpot lifecycle Journal needs attention:', diagnostic);
			await ctx.runMutation(internal.hubspotJournal.release, {
				claim,
				diagnostic: diagnostic.slice(0, 500)
			});
		}
		return null;
	}
});
