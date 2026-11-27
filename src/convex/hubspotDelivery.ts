import { credentialConnection } from './hubspotCredentials';
import { markDealUnavailable } from './contractPolicy';
import { Workpool, vOnCompleteArgs } from '@convex-dev/workpool';
import { v } from 'convex/values';
import { paginationResultValidator, type PaginationResult } from 'convex/server';
import { components, internal } from './_generated/api';
import { env, internalMutation, internalQuery } from './_generated/server';
import { availableCompany } from './auth';
import { readContract } from './contractState';
import schema from './schema';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { blockLink } from './hubspotRecords';
import { requireReconnect } from './hubspotConnections';
import {
	CLAIM_MS,
	deliveryFacts,
	deliveryMode,
	observationExpired,
	sameDestination
} from './hubspotDeliveryPolicy';
import { confirmUpload, exportDelivery } from './hubspotExportDeliveries';

export const pool = new Workpool(components.hubspotPool, {
	maxParallelism: 5,
	retryActionsByDefault: false
});
const pumpStatuses = ['pending', 'uncertain', 'working', 'blocked'] as const;
function wakeAt(row: Doc<'hubspotEvents'>) {
	return row.workId ? (row.leaseUntil ?? row.dueAt) + 30_000 : row.dueAt;
}
export async function scheduleDelivery(ctx: MutationCtx, id: Id<'hubspotEvents'>) {
	const row = await ctx.db.get('hubspotEvents', id);
	if (row && pumpStatuses.some((status) => status === row.status)) {
		const at = wakeAt(row);
		await ctx.scheduler.runAt(at, internal.hubspotDelivery.wake, { id, at });
	}
}
/** A stale retry or lease job never starts a fresh pass. */
export const wake = internalMutation({
	args: { id: v.id('hubspotEvents'), at: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const row = await ctx.db.get('hubspotEvents', args.id);
		if (
			row &&
			pumpStatuses.some((status) => status === row.status) &&
			wakeAt(row) === args.at &&
			args.at <= Date.now()
		)
			await ctx.scheduler.runAfter(0, internal.hubspotDelivery.pump, {});
		return null;
	}
});

/** Native pagination has one-query-per-execution scope; the parent shares its row budget. */
export const duePage = internalQuery({
	args: {
		status: v.union(...pumpStatuses.map((status) => v.literal(status))),
		cutoff: v.number(),
		cursor: v.union(v.string(), v.null()),
		limit: v.number()
	},
	returns: paginationResultValidator(schema.doc('hubspotEvents')),
	handler: (ctx, args) =>
		ctx.db
			.query('hubspotEvents')
			.withIndex('by_status_and_dueAt', (q) =>
				q.eq('status', args.status).lte('dueAt', args.cutoff)
			)
			.paginate({
				cursor: args.cursor,
				numItems: Math.max(1, Math.min(20, args.limit)),
				maximumRowsRead: Math.max(1, Math.min(20, args.limit)),
				maximumBytesRead: 1024 * 1024
			})
});

/** Each fixed-cutoff pass advances past skipped rows before visiting the next status. */
export const pump = internalMutation({
	args: {
		status: v.optional(v.union(...pumpStatuses.map((status) => v.literal(status)))),
		cutoff: v.optional(v.number()),
		cursor: v.optional(v.string())
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		if (env.HUBSPOT_ENABLED !== 'true' || env.HUBSPOT_DELIVERY_ENABLED !== 'true') return null;
		const now = Date.now();
		const cutoff = args.cutoff ?? now;
		let remaining = 20;
		for (
			let index = pumpStatuses.indexOf(args.status ?? pumpStatuses[0]);
			index < pumpStatuses.length;
			index++
		) {
			const status = pumpStatuses[index];
			const rows = () =>
				ctx.db
					.query('hubspotEvents')
					.withIndex('by_status_and_dueAt', (q) => q.eq('status', status).lte('dueAt', cutoff));
			if (remaining === 0) {
				if (await rows().first()) {
					await ctx.scheduler.runAfter(0, internal.hubspotDelivery.pump, { status, cutoff });
					break;
				}
				continue;
			}
			const page: PaginationResult<Doc<'hubspotEvents'>> = await ctx.runQuery(
				internal.hubspotDelivery.duePage,
				{
					status,
					cutoff,
					cursor: status === args.status ? (args.cursor ?? null) : null,
					limit: remaining
				}
			);
			remaining -= page.page.length;
			for (const row of page.page) {
				if (!(await availableCompany(ctx, row.companyId))) continue;
				// Cancellation cannot stop a running action. Its lease and request reserve must retire first.
				if (row.workId && (row.leaseUntil ?? row.dueAt) + 30_000 > now) continue;
				if (row.workId) await pool.cancel(ctx, row.workId as import('@convex-dev/workpool').WorkId);
				const mode = deliveryMode(row, await deliveryFacts(ctx, row), now);
				const reset = {
					workId: undefined,
					execution: undefined,
					claim: undefined,
					leaseUntil: undefined
				};
				if (mode !== 'fresh' && mode !== 'observe') {
					await ctx.db.patch('hubspotEvents', row._id, {
						...reset,
						status: mode,
						dueAt: now + CLAIM_MS,
						diagnostic:
							mode === 'paused'
								? 'Linked HubSpot deal unavailable or replaced'
								: mode === 'attention'
									? 'Original write observation horizon ended'
									: 'Reconnect HubSpot'
					});
					await scheduleDelivery(ctx, row._id);
					continue;
				}
				const execution = `${row._id}:${now}:${Math.random()}`;
				const workId = await pool.enqueueAction(
					ctx,
					internal.hubspotSender.send,
					{ id: row._id, execution },
					{
						retry: false,
						onComplete: internal.hubspotDelivery.completed,
						context: { id: row._id, execution }
					}
				);
				await ctx.db.patch('hubspotEvents', row._id, {
					...reset,
					execution,
					workId,
					status: row.dispatch ? 'uncertain' : 'pending',
					dueAt: now + CLAIM_MS
				});
				await scheduleDelivery(ctx, row._id);
			}
			if (!page.isDone) {
				await ctx.scheduler.runAfter(0, internal.hubspotDelivery.pump, {
					status,
					cutoff,
					cursor: page.continueCursor
				});
				break;
			}
		}

		return null;
	}
});
export const claim = internalMutation({
	args: { id: v.id('hubspotEvents'), claim: v.string(), execution: v.string() },
	returns: v.union(schema.doc('hubspotEvents'), v.null()),
	handler: async (ctx, args) => {
		const row = await ctx.db.get('hubspotEvents', args.id),
			now = Date.now();
		if (
			!row ||
			row.execution !== args.execution ||
			!row.workId ||
			!['pending', 'uncertain', 'blocked'].includes(row.status) ||
			!(await availableCompany(ctx, row.companyId)) ||
			env.HUBSPOT_ENABLED !== 'true' ||
			env.HUBSPOT_DELIVERY_ENABLED !== 'true'
		)
			return null;
		const mode = deliveryMode(row, await deliveryFacts(ctx, row), now);
		if (mode !== 'fresh' && mode !== 'observe') {
			await ctx.db.patch('hubspotEvents', row._id, { status: mode, dueAt: now + CLAIM_MS });
			await scheduleDelivery(ctx, row._id);
			return null;
		}
		const changes = {
			status: 'working' as const,
			claim: args.claim,
			leaseUntil: now + CLAIM_MS,
			dueAt: now + CLAIM_MS,
			tries: row.tries + 1,
			operatorObservation: undefined
		};
		await ctx.db.patch('hubspotEvents', row._id, changes);
		await scheduleDelivery(ctx, row._id);
		// Operator authority is returned once, consumed transactionally; it never resets the horizon.
		return { ...row, ...changes, operatorObservation: row.operatorObservation };
	}
});
export const data = internalQuery({
	args: { id: v.id('hubspotEvents') },
	returns: v.union(
		v.object({
			event: schema.doc('hubspotEvents'),
			attempt: v.union(schema.doc('wordExports'), v.null()),
			delivery: v.union(schema.doc('hubspotExportDeliveries'), v.null())
		}),
		v.null()
	),
	handler: async (ctx, { id }) => {
		const event = await ctx.db.get('hubspotEvents', id);
		if (!event || !(await availableCompany(ctx, event.companyId))) return null;
		const attempt = event.attemptId ? await ctx.db.get('wordExports', event.attemptId) : null;
		const delivery = attempt ? await exportDelivery(ctx, attempt) : null;
		return { event, attempt, delivery };
	}
});
/** Read authority is scoped to this claim and original account, even after link repair. */
export const authorizeRead = internalQuery({
	args: { id: v.id('hubspotEvents'), claim: v.string(), generation: v.number(), now: v.number() },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const row = await ctx.db.get('hubspotEvents', args.id);
		if (
			!row ||
			row.claim !== args.claim ||
			row.status !== 'working' ||
			(row.leaseUntil ?? 0) <= args.now ||
			!(await availableCompany(ctx, row.companyId)) ||
			env.HUBSPOT_ENABLED !== 'true' ||
			env.HUBSPOT_DELIVERY_ENABLED !== 'true'
		)
			return false;
		const c = await credentialConnection(ctx, row.destination.connectionId);
		return Boolean(
			c &&
			c.generation === args.generation &&
			c.status === 'connected' &&
			c.companyId === row.companyId &&
			c.accountId === row.destination.accountId
		);
	}
});
export const checkpoint = internalMutation({
	args: {
		id: v.id('hubspotEvents'),
		claim: v.string(),
		observation: schema.doc('hubspotEvents').fields.observation
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const row = await ctx.db.get('hubspotEvents', args.id);
		if (
			!row ||
			row.claim !== args.claim ||
			row.status !== 'working' ||
			row.dispatchId !== args.observation?.dispatchId ||
			row.dispatch !== args.observation?.kind ||
			(row.leaseUntil ?? 0) <= Date.now() ||
			!(await availableCompany(ctx, row.companyId))
		)
			return false;
		const connection = await credentialConnection(ctx, row.destination.connectionId);
		if (!connection || connection.status === 'retiring') return false;
		await ctx.db.patch('hubspotEvents', row._id, { observation: args.observation });
		return true;
	}
});
export const dispatch = internalMutation({
	args: {
		id: v.id('hubspotEvents'),
		claim: v.string(),
		generation: v.number(),
		kind: v.union(v.literal('file'), v.literal('note'))
	},
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		const row = await ctx.db.get('hubspotEvents', args.id);
		if (
			!row ||
			row.claim !== args.claim ||
			row.dispatch ||
			row.status !== 'working' ||
			(row.leaseUntil ?? 0) <= Date.now() ||
			!(await availableCompany(ctx, row.companyId)) ||
			env.HUBSPOT_ENABLED !== 'true' ||
			env.HUBSPOT_DELIVERY_ENABLED !== 'true'
		)
			return null;
		const facts = await deliveryFacts(ctx, row);
		if (
			deliveryMode(row, facts, Date.now()) !== 'fresh' ||
			facts.connection?.generation !== args.generation
		)
			return null;
		const dispatchId = `${args.claim}:${args.kind}`;
		await ctx.db.patch('hubspotEvents', row._id, {
			dispatch: args.kind,
			dispatchId,
			dispatchedAt: Date.now(),
			observation: undefined
		});
		return dispatchId;
	}
});
export const settle = internalMutation({
	args: {
		id: v.id('hubspotEvents'),
		claim: v.string(),
		generation: v.number(),
		outcome: v.union(
			v.literal('file'),
			v.literal('sent'),
			v.literal('retry'),
			v.literal('unavailable'),
			v.literal('uncertain'),
			v.literal('attention'),
			v.literal('reconnect'),
			v.literal('blocked')
		),
		remoteId: v.optional(v.string()),
		delay: v.optional(v.number()),
		diagnostic: v.optional(v.string()),
		dispatchId: v.optional(v.string()),
		definitelyUnsent: v.optional(v.boolean())
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const row = await ctx.db.get('hubspotEvents', args.id);
		if (
			!row ||
			row.claim !== args.claim ||
			row.status !== 'working' ||
			!(await availableCompany(ctx, row.companyId))
		)
			return null;
		const now = Date.now(),
			facts = await deliveryFacts(ctx, row);
		const currentCredentials =
			facts.accountValid && facts.connection?.generation === args.generation;
		const positive = args.outcome === 'file' || args.outcome === 'sent';
		if (
			positive &&
			(!row.dispatch ||
				!row.dispatchId ||
				row.dispatchId !== args.dispatchId ||
				row.dispatch !== (args.outcome === 'file' ? 'file' : 'note') ||
				!args.remoteId)
		)
			return null;
		const clear = {
			dispatch: undefined,
			dispatchId: undefined,
			dispatchedAt: undefined,
			observation: undefined
		};
		if (positive) {
			if (args.outcome === 'sent') {
				await ctx.db.patch('hubspotEvents', row._id, {
					...clear,
					status: 'sent',
					noteId: args.remoteId,
					claim: undefined,
					leaseUntil: undefined,
					operatorObservation: undefined
				});
				await scheduleDelivery(ctx, row._id);
			} else {
				if (row.attemptId) await confirmUpload(ctx, row.attemptId, args.remoteId!);
				const canContinue =
					facts.linkValid &&
					currentCredentials &&
					facts.connection?.status === 'connected' &&
					!observationExpired(row, now);
				await ctx.db.patch('hubspotEvents', row._id, {
					...clear,
					fileId: args.remoteId,
					status:
						!facts.connection || facts.connection.status === 'retiring'
							? 'retired'
							: canContinue
								? 'working'
								: !facts.linkValid
									? 'paused'
									: observationExpired(row, now)
										? 'attention'
										: facts.accountValid && facts.connection?.status === 'connected'
											? 'pending'
											: 'blocked',
					...(!canContinue ? { claim: undefined, leaseUntil: undefined } : {}),
					diagnostic: canContinue
						? undefined
						: 'File reconciled; fresh Note requires the original live link'
				});
				await scheduleDelivery(ctx, row._id);
			}
			return null;
		}
		// Shared link/reconnect effects require current evidence before any durable block is installed.
		if (
			currentCredentials &&
			facts.connection?.status === 'connected' &&
			(row.leaseUntil ?? 0) > now &&
			args.outcome === 'unavailable'
		) {
			const root = await ctx.db.get('savedContracts', row.contractId);
			const contract = root ? await readContract(ctx, root) : null;
			if (contract?.root.companyId === row.companyId && sameDestination(contract.hubspot, row))
				await markDealUnavailable(ctx, contract);
			else await blockLink(ctx, row.companyId, row.contractId, row.destination.generation);
		}
		if (args.outcome === 'reconnect')
			await requireReconnect(ctx, {
				id: row.destination.connectionId,
				companyId: row.companyId,
				accountId: row.destination.accountId,
				generation: args.generation
			});
		const definitelyUnsent =
			args.definitelyUnsent && args.dispatchId && args.dispatchId === row.dispatchId;
		const retained = row.dispatch && !definitelyUnsent;
		const updated = retained ? row : { ...row, ...clear };
		const mode = deliveryMode(updated, await deliveryFacts(ctx, row), now);
		const status =
			mode === 'fresh'
				? args.outcome === 'attention'
					? 'attention'
					: 'pending'
				: mode === 'observe'
					? args.outcome === 'attention'
						? 'attention'
						: 'uncertain'
					: mode;
		await ctx.db.patch('hubspotEvents', row._id, {
			...(definitelyUnsent ? clear : {}),
			status,
			claim: undefined,
			leaseUntil: undefined,
			operatorObservation: undefined,
			dueAt: now + Math.max(1000, args.delay ?? 60_000),
			diagnostic: args.diagnostic
		});
		await scheduleDelivery(ctx, row._id);
		return null;
	}
});
export const completed = internalMutation({
	args: vOnCompleteArgs(v.object({ id: v.id('hubspotEvents'), execution: v.string() })).fields,
	returns: v.null(),
	handler: async (ctx, args) => {
		const row = await ctx.db.get('hubspotEvents', args.context.id);
		if (!row || row.workId !== args.workId || row.execution !== args.context.execution) return null;
		const unfinished = ['pending', 'working', 'uncertain', 'blocked'].includes(row.status);
		const mode = unfinished ? deliveryMode(row, await deliveryFacts(ctx, row), Date.now()) : null;
		await ctx.db.patch('hubspotEvents', row._id, {
			workId: undefined,
			execution: undefined,
			claim: undefined,
			leaseUntil: undefined,
			...(mode
				? {
						status: mode === 'fresh' ? 'pending' : mode === 'observe' ? 'uncertain' : mode,
						dueAt: Date.now() + 60_000
					}
				: {})
		});
		await scheduleDelivery(ctx, row._id);
		return null;
	}
});
