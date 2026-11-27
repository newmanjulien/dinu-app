import type { WorkId } from '@convex-dev/workpool';
import { ConvexError, v, type Infer } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalAction, internalMutation, mutation, type MutationCtx } from './_generated/server';
import { availableCompany, requirePermission } from './auth';
import { tokenExchange } from './hubspotApi';
import type { CredentialConnection } from './hubspotCredentials';
import {
	connectionWithCredentials,
	credentialConnection,
	credentialsFor,
	deleteCredentials
} from './hubspotCredentials';
import { pool } from './hubspotDelivery';
import { retireExportDelivery } from './hubspotExportDeliveries';
import { lifecycle, otherAttachments, portalLifecycle } from './hubspotInstallation';
import { disableQuotes } from './hubspotQuotesInstallation';
import { quoteRunningUntil } from './hubspotQuoteValidators';
import { hubspotRemovalOutcome } from './hubspotValidators';

// Wait out the bounded provider fetch and refresh claims before purging secrets/files.
const REQUEST_RESERVE = 30_000;
const PROVIDER_LEASE = 90_000;

async function schedule(ctx: MutationCtx, id: Id<'hubspotRemovals'>, delay = 0) {
	const dueAt = Date.now() + delay;
	await ctx.db.patch('hubspotRemovals', id, { dueAt });
	await ctx.scheduler.runAt(dueAt, internal.hubspotUninstall.progress, { id, dueAt });
}

export async function retireInstallation(
	ctx: MutationCtx,
	connection: Doc<'hubspotConnections'>,
	source: 'workspace' | 'hubspot',
	actorId?: Id<'profiles'>
) {
	const prior = await ctx.db
		.query('hubspotRemovals')
		.withIndex('by_connectionId', (q) => q.eq('connectionId', connection._id))
		.unique();
	if (prior) return prior._id;
	const state = await lifecycle(ctx, connection.companyId);
	const shared =
		source === 'workspace' &&
		(await otherAttachments(ctx, connection.accountId, connection.companyId));
	const providerDue = Date.now() + PROVIDER_LEASE;
	const providerId = await ctx.db.insert('hubspotAccountRemovals', {
		accountId: connection.accountId,
		createdAt: Date.now(),
		provider: source === 'hubspot' ? 'confirmed' : shared ? 'shared' : 'pending',
		blocking: !shared,
		detached: false,
		dueAt: providerDue
	});
	await ctx.scheduler.runAt(providerDue, internal.hubspotUninstall.recoverProvider, {
		id: providerId,
		dueAt: providerDue
	});
	const id = await ctx.db.insert('hubspotRemovals', {
		companyId: connection.companyId,
		connectionId: connection._id,
		accountId: connection.accountId,
		actorId,
		source,
		createdAt: Date.now(),
		providerId,
		done: false,
		dueAt: Date.now(),
		phase: 'quotes',
		cursor: null
	});
	await ctx.db.patch('hubspotAccountRemovals', providerId, { removalId: id });
	await ctx.db.patch('hubspotConnections', connection._id, { status: 'retiring' });
	await disableQuotes(ctx, connection.companyId);
	if (state)
		await ctx.db.patch('hubspotLifecycles', state._id, {
			version: state.version + 1,
			removalId: id,
			removedAt: Date.now()
		});
	else
		await ctx.db.insert('hubspotLifecycles', {
			companyId: connection.companyId,
			version: 1,
			removalId: id,
			removedAt: Date.now()
		});
	// Version invalidation is immediate; existing expirer removes the now-useless OAuth states.
	await schedule(ctx, id);
	return id;
}

export const uninstall = mutation({
	args: { membershipId: v.id('memberships'), connectionId: v.id('hubspotConnections') },
	returns: v.id('hubspotRemovals'),
	handler: async (ctx, args) => {
		const access = await requirePermission(ctx, 'manageIntegrations', args.membershipId);
		const connection = await ctx.db.get('hubspotConnections', args.connectionId);
		if (connection) {
			if (connection.companyId !== access.companyId)
				throw new ConvexError('This HubSpot connection changed. Reload to see its status.');
			return retireInstallation(ctx, connection, 'workspace', access.profile._id);
		}
		const previous = await ctx.db
			.query('hubspotRemovals')
			.withIndex('by_connectionId', (q) => q.eq('connectionId', args.connectionId))
			.unique();
		if (previous?.companyId === access.companyId) return previous._id;
		throw new ConvexError('This HubSpot connection changed. Reload to see its status.');
	}
});

async function scheduleProvider(ctx: MutationCtx, id: Id<'hubspotAccountRemovals'>, delay = 0) {
	const dueAt = Date.now() + delay;
	await ctx.db.patch('hubspotAccountRemovals', id, { dueAt });
	await ctx.scheduler.runAt(dueAt, internal.hubspotUninstall.recoverProvider, { id, dueAt });
}

/** Also works after tenant history/credentials are erased. Never dispatches a DELETE. */
async function advanceProvider(ctx: MutationCtx, operation: Doc<'hubspotAccountRemovals'>) {
	const local = operation.removalId
		? await ctx.db.get('hubspotRemovals', operation.removalId)
		: null;
	const elapsed = (operation.dispatchedAt ?? 0) + PROVIDER_LEASE <= Date.now();
	if (operation.provider === 'dispatched' && elapsed) {
		const started = operation.deleteStartedAt !== undefined;
		const changes = {
			provider: started ? ('unknown' as const) : ('attention' as const),
			...(!started ? { settledAt: Date.now() } : {}),
			diagnostic: 'Provider removal did not complete; verify the installation in HubSpot'
		};
		await ctx.db.patch('hubspotAccountRemovals', operation._id, changes);
		operation = { ...operation, ...changes };
	}
	const terminal = operation.provider !== 'pending' && operation.provider !== 'dispatched';
	const settled = operation.settledAt !== undefined || !operation.dispatchedAt || elapsed;
	if (terminal && settled && (operation.detached || local?.done)) {
		if (operation.provider !== 'unknown' && operation.detached) {
			await ctx.db.delete('hubspotAccountRemovals', operation._id);
		} else {
			await ctx.db.patch('hubspotAccountRemovals', operation._id, {
				blocking: operation.provider === 'unknown',
				dueAt: undefined
			});
		}
		return;
	}
	if (local && !local.done && terminal && settled) await schedule(ctx, local._id);
	await scheduleProvider(
		ctx,
		operation._id,
		operation.provider === 'dispatched' || !settled
			? Math.max(0, (operation.dispatchedAt ?? 0) + PROVIDER_LEASE - Date.now())
			: PROVIDER_LEASE
	);
}

/** Serializes erasure with last-moment DELETE authorization on the account operation. */
export async function detachProvider(ctx: MutationCtx, removal: Doc<'hubspotRemovals'>) {
	const operation = await ctx.db.get('hubspotAccountRemovals', removal.providerId);
	if (!operation) return;
	const changes = {
		detached: true,
		...(operation.deleteStartedAt === undefined
			? {
					provider:
						operation.provider === 'pending' || operation.provider === 'dispatched'
							? ('attention' as const)
							: operation.provider,
					settledAt: Date.now()
				}
			: {})
	};
	await ctx.db.patch('hubspotAccountRemovals', operation._id, changes);
	await advanceProvider(ctx, { ...operation, ...changes });
}

async function finish(ctx: MutationCtx, removal: Doc<'hubspotRemovals'>) {
	const connection = await credentialConnection(ctx, removal.connectionId);
	if (connection?.status === 'retiring') {
		await deleteCredentials(ctx, connection._id);
		await ctx.db.delete('hubspotConnections', connection._id);
	}
	await ctx.db.patch('hubspotRemovals', removal._id, { done: true, finishedAt: Date.now() });
	const operation = await ctx.db.get('hubspotAccountRemovals', removal.providerId);
	if (operation) await advanceProvider(ctx, operation);
}

export const recoverProvider = internalMutation({
	args: { id: v.id('hubspotAccountRemovals'), dueAt: v.optional(v.number()) },
	returns: v.null(),
	handler: async (ctx, { id, dueAt }) => {
		const operation = await ctx.db.get('hubspotAccountRemovals', id);
		if (operation && (dueAt === undefined || (operation.dueAt === dueAt && dueAt <= Date.now())))
			await advanceProvider(ctx, operation);
		return null;
	}
});

export const progress = internalMutation({
	args: { id: v.id('hubspotRemovals'), dueAt: v.optional(v.number()) },
	returns: v.null(),
	handler: async (ctx, { id, dueAt }) => {
		const removal = await ctx.db.get('hubspotRemovals', id);
		if (
			!removal ||
			removal.done ||
			(dueAt !== undefined && (removal.dueAt !== dueAt || dueAt > Date.now()))
		)
			return null;
		if (removal.phase === 'quotes') {
			const page = await ctx.db
				.query('hubspotQuotePushes')
				.withIndex('by_destination_connectionId', (q) =>
					q.eq('destination.connectionId', removal.connectionId)
				)
				.paginate({ cursor: removal.cursor, numItems: 25 });
			let wait = 0;
			for (const row of page.page) {
				if (row.workId) await pool.cancel(ctx, row.workId as WorkId);
				const remaining = quoteRunningUntil(row) - Date.now();
				if (remaining > 0) {
					wait = Math.max(wait, remaining);
					continue;
				}
				if (['queued', 'dispatched', 'verifying'].includes(row.state))
					await ctx.db.patch('hubspotQuotePushes', row._id, {
						state: row.state === 'dispatched' ? 'unknown' : row.quoteId ? 'attention' : 'retired',
						dueAt: undefined,
						leaseUntil: undefined,
						workId: undefined,
						claim: row.state === 'dispatched' ? row.claim : undefined,
						message:
							row.state === 'dispatched'
								? 'HubSpot may have created this quote. Contact Dinu support before pushing this version again.'
								: 'HubSpot was removed. Existing quotes stay in HubSpot.'
					});
			}
			if (!wait)
				await ctx.db.patch('hubspotRemovals', id, {
					cursor: page.isDone ? null : page.continueCursor,
					phase: page.isDone ? 'events' : 'quotes'
				});
			await schedule(ctx, id, wait);
			return null;
		}
		if (removal.phase === 'events') {
			const page = await ctx.db
				.query('hubspotEvents')
				.withIndex('by_destination_connectionId', (q) =>
					q.eq('destination.connectionId', removal.connectionId)
				)
				.paginate({ cursor: removal.cursor, numItems: 25, maximumBytesRead: 2 * 1024 * 1024 });
			let wait = 0;
			for (const row of page.page) {
				if (
					row.status === 'sent' &&
					row.workId === undefined &&
					row.execution === undefined &&
					row.claim === undefined &&
					row.leaseUntil === undefined &&
					row.operatorObservation === undefined
				)
					continue;
				if (row.workId) await pool.cancel(ctx, row.workId as WorkId);
				const remaining = (row.leaseUntil ?? 0) + REQUEST_RESERVE - Date.now();
				if (remaining > 0) {
					wait = Math.max(wait, remaining);
					continue;
				}
				await ctx.db.patch('hubspotEvents', row._id, {
					status: row.status === 'sent' ? 'sent' : 'retired',
					workId: undefined,
					execution: undefined,
					claim: undefined,
					leaseUntil: undefined,
					operatorObservation: undefined,
					...(row.status !== 'sent'
						? { diagnostic: 'HubSpot installation removed; activity will not be replayed' }
						: {})
				});
			}
			// Keep the cursor before any active lease so the page is revisited after it settles.
			if (!wait)
				await ctx.db.patch('hubspotRemovals', id, {
					cursor: page.isDone ? null : page.continueCursor,
					phase: page.isDone ? 'exportDeliveries' : 'events'
				});
			await schedule(ctx, id, wait);
			return null;
		}
		if (removal.phase === 'exportDeliveries') {
			const page = await ctx.db
				.query('hubspotExportDeliveries')
				.withIndex('by_destination_connectionId', (q) =>
					q.eq('destination.connectionId', removal.connectionId)
				)
				.paginate({ cursor: removal.cursor, numItems: 25, maximumBytesRead: 2 * 1024 * 1024 });
			for (const delivery of page.page) await retireExportDelivery(ctx, delivery);
			await ctx.db.patch('hubspotRemovals', id, {
				cursor: page.isDone ? null : page.continueCursor,
				phase: page.isDone ? 'provider' : 'exportDeliveries'
			});
			await schedule(ctx, id);
			return null;
		}
		const operation = await ctx.db.get('hubspotAccountRemovals', removal.providerId);
		if (!operation) throw new Error('Missing HubSpot provider operation');
		if (operation.provider === 'pending') {
			const connection = await credentialConnection(ctx, removal.connectionId);
			const wait = (connection?.refreshUntil ?? 0) + REQUEST_RESERVE - Date.now();
			if (wait > 0) {
				await schedule(ctx, id, wait);
				return null;
			}
			const dueAt = Date.now() + PROVIDER_LEASE;
			await ctx.db.patch('hubspotRemovals', id, { dueAt });
			await ctx.scheduler.runAt(dueAt, internal.hubspotUninstall.progress, { id, dueAt });
			await ctx.scheduler.runAfter(0, internal.hubspotUninstall.removeProvider, {
				id: operation._id
			});
			return null;
		}
		if (operation.provider === 'dispatched') {
			await advanceProvider(ctx, operation);
			const current = await ctx.db.get('hubspotAccountRemovals', operation._id);
			if (current?.provider === 'dispatched') return null;
		}
		const current = await ctx.db.get('hubspotAccountRemovals', operation._id);
		if (!current) return null;
		const reserve = (current.dispatchedAt ?? 0) + PROVIDER_LEASE - Date.now();
		if (reserve > 0 && current.settledAt === undefined) {
			await schedule(ctx, id, reserve);
			return null;
		}
		await finish(ctx, removal);
		return null;
	}
});

export const claimProvider = internalMutation({
	args: { id: v.id('hubspotAccountRemovals') },
	returns: v.union(connectionWithCredentials, v.null()),
	handler: async (ctx, { id }) => {
		const operation = await ctx.db.get('hubspotAccountRemovals', id);
		if (!operation || operation.detached || operation.provider !== 'pending') return null;
		const removal = operation.removalId
			? await ctx.db.get('hubspotRemovals', operation.removalId)
			: null;
		if (!removal || removal.done || removal.phase !== 'provider') return null;
		const connection = await credentialConnection(ctx, removal.connectionId);
		if (
			!connection ||
			connection.status !== 'retiring' ||
			!(await availableCompany(ctx, removal.companyId))
		) {
			await ctx.db.patch('hubspotAccountRemovals', id, {
				provider: 'attention',
				settledAt: Date.now()
			});
			await schedule(ctx, removal._id);
			return null;
		}
		if (await otherAttachments(ctx, operation.accountId, removal.companyId)) {
			await ctx.db.patch('hubspotAccountRemovals', id, { provider: 'shared' });
			await schedule(ctx, removal._id);
			return null;
		}
		if ((connection.refreshUntil ?? 0) + REQUEST_RESERVE > Date.now()) {
			await schedule(ctx, removal._id, 60_000);
			return null;
		}
		await ctx.db.patch('hubspotAccountRemovals', id, {
			provider: 'dispatched',
			dispatchedAt: Date.now()
		});
		await scheduleProvider(ctx, id, PROVIDER_LEASE);
		return connection;
	}
});

export const authorizeDelete = internalMutation({
	args: {
		id: v.id('hubspotAccountRemovals'),
		tokens: v.optional(
			v.object({ accessToken: v.string(), refreshToken: v.string(), expiresAt: v.number() })
		)
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const operation = await ctx.db.get('hubspotAccountRemovals', args.id);
		if (
			!operation ||
			operation.detached ||
			operation.provider !== 'dispatched' ||
			operation.deleteStartedAt !== undefined ||
			(operation.dispatchedAt ?? 0) + 50_000 < Date.now()
		)
			return false;
		const removal = operation.removalId
			? await ctx.db.get('hubspotRemovals', operation.removalId)
			: null;
		if (!removal || removal.done) return false;
		const connection = await credentialConnection(ctx, removal.connectionId);
		if (
			!connection ||
			connection.status !== 'retiring' ||
			!(await availableCompany(ctx, removal.companyId))
		)
			return false;
		const portal = await portalLifecycle(ctx, operation.accountId);
		if ((portal?.installedAt ?? 0) > operation.createdAt) {
			await ctx.db.patch('hubspotAccountRemovals', operation._id, {
				provider: 'attention',
				settledAt: Date.now(),
				diagnostic: 'Newer HubSpot installation observed; finish removal in HubSpot'
			});
			await schedule(ctx, removal._id);
			return false;
		}
		if (await otherAttachments(ctx, operation.accountId, removal.companyId)) {
			await ctx.db.patch('hubspotAccountRemovals', operation._id, {
				provider: 'shared',
				settledAt: Date.now()
			});
			await schedule(ctx, removal._id);
			return false;
		}
		if (args.tokens)
			await ctx.db.patch('hubspotCredentials', (await credentialsFor(ctx, connection._id))!._id, {
				...args.tokens,
				generation: connection.generation + 1
			});
		await ctx.db.patch('hubspotAccountRemovals', operation._id, { deleteStartedAt: Date.now() });
		return true;
	}
});

export const providerResult = internalMutation({
	args: {
		id: v.id('hubspotAccountRemovals'),
		provider: hubspotRemovalOutcome,
		diagnostic: v.optional(v.string())
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const operation = await ctx.db.get('hubspotAccountRemovals', args.id);
		if (!operation || operation.provider === 'shared' || operation.dispatchedAt === undefined)
			return null;
		// A trusted Journal/operator confirmation cannot be downgraded by a late transport failure.
		if (operation.provider === 'confirmed' && args.provider !== 'confirmed') return null;
		if (
			operation.provider !== 'dispatched' &&
			operation.provider !== 'unknown' &&
			operation.provider !== 'confirmed'
		)
			return null;
		const changes = {
			provider: args.provider,
			diagnostic: args.diagnostic,
			...(args.provider === 'confirmed' || args.provider === 'attention'
				? { settledAt: Date.now() }
				: {})
		};
		await ctx.db.patch('hubspotAccountRemovals', operation._id, changes);
		await advanceProvider(ctx, { ...operation, ...changes });
		return null;
	}
});

export const removeProvider = internalAction({
	args: { id: v.id('hubspotAccountRemovals') },
	returns: v.null(),
	handler: async (ctx, { id }): Promise<null> => {
		const connection: CredentialConnection | null = await ctx.runMutation(
			internal.hubspotUninstall.claimProvider,
			{ id }
		);
		if (!connection) return null;
		let provider: Infer<typeof hubspotRemovalOutcome> = 'attention';
		let diagnostic = 'Finish removing Dinu Contracts in HubSpot Connected Apps';
		let started = false;
		try {
			const tokens =
				connection.expiresAt <= Date.now() + 30_000
					? await tokenExchange({
							grant_type: 'refresh_token',
							refresh_token: connection.refreshToken
						})
					: undefined;
			if (!(await ctx.runMutation(internal.hubspotUninstall.authorizeDelete, { id, tokens })))
				return null;
			started = true;
			const response = await fetch('https://api.hubapi.com/appinstalls/2026-09/external-install', {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${tokens?.accessToken ?? connection.accessToken}` },
				signal: AbortSignal.timeout(25_000)
			});
			provider =
				response.status === 204
					? 'confirmed'
					: [400, 401, 403, 404, 429].includes(response.status)
						? 'attention'
						: 'unknown';
			diagnostic =
				provider === 'confirmed'
					? 'HubSpot confirmed app removal'
					: `HubSpot removal returned ${response.status}; finish in Connected Apps`;
		} catch {
			provider = started ? 'unknown' : 'attention';
		}
		await ctx.runMutation(internal.hubspotUninstall.providerResult, { id, provider, diagnostic });
		return null;
	}
});

// Scheduled recovery never resends a dispatched DELETE. It settles uncertainty and purges secrets.
export const resume = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const rows = await ctx.db
			.query('hubspotRemovals')
			.withIndex('by_done_and_dueAt', (q) => q.eq('done', false).lte('dueAt', Date.now()))
			.take(10);
		for (const row of rows) await schedule(ctx, row._id);
		const operations = await ctx.db
			.query('hubspotAccountRemovals')
			.withIndex('by_dueAt', (q) => q.gte('dueAt', 0).lte('dueAt', Date.now()))
			.take(10);
		for (const operation of operations) await advanceProvider(ctx, operation);
		return null;
	}
});

/** Operator-only after verifying the account in HubSpot; never dispatches another DELETE. */
export const reconcile = internalMutation({
	args: { id: v.id('hubspotAccountRemovals'), evidence: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		if (!args.evidence.trim() || args.evidence.length > 2000)
			throw new ConvexError('Provide an evidence reference.');
		const operation = await ctx.db.get('hubspotAccountRemovals', args.id);
		if (
			!operation ||
			!operation.blocking ||
			operation.provider !== 'unknown' ||
			(operation.dispatchedAt ?? 0) + PROVIDER_LEASE > Date.now()
		)
			throw new ConvexError('This removal is not ready for reconciliation.');
		const changes = {
			provider: 'confirmed' as const,
			diagnostic: `Operator verified removal: ${args.evidence}`
		};
		await ctx.db.patch('hubspotAccountRemovals', operation._id, changes);
		await advanceProvider(ctx, { ...operation, ...changes });
		return null;
	}
});
