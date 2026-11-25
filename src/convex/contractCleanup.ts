import type { WorkId } from '@convex-dev/workpool';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { companyDeletion } from './auth';
import { resetQuota } from './buyerActivityQuota';
import { linkFor } from './buyerLinks';
import { cleanupBudget, CLEANUP_DISCOVERY_PAGE_SIZE } from './cleanup';
import { removeDirectoryEntry } from './contractDirectory';
import { activeJob, RETIRED_DELIVERY_RECHECK, retireDelivery } from './emailDeliveries';
import { pool } from './hubspotDelivery';
import { exportDelivery } from './hubspotExportDeliveries';
import { quoteRunningUntil } from './hubspotQuoteValidators';
import { deleteUnownedFile } from './storageOwnership';

async function schedule(
	ctx: MutationCtx,
	marker: Doc<'contractCleanups'>,
	phase = marker.phase,
	delay = 0,
	cursor: string | undefined = marker.cursor
) {
	const generation = marker.generation + 1;
	const jobId = await ctx.scheduler.runAfter(delay, internal.contractCleanup.clean, {
		markerId: marker._id,
		generation
	});
	await ctx.db.patch('contractCleanups', marker._id, {
		phase,
		cursor,
		generation,
		jobId,
		waitingDueAt: delay > 0 ? Date.now() + delay : undefined
	});
}

async function ensureScheduled(ctx: MutationCtx, marker: Doc<'contractCleanups'>) {
	if (!(await activeJob(ctx, marker.jobId))) await schedule(ctx, marker);
}

/** Called only after current company access has been verified, in the delete transaction. */
export async function ensureContractCleanup(
	ctx: MutationCtx,
	companyId: Id<'company'>,
	contractId: Id<'savedContracts'>,
	create: boolean
) {
	let marker = await ctx.db
		.query('contractCleanups')
		.withIndex('by_contractId', (q) => q.eq('contractId', contractId))
		.unique();
	if (create || marker?.companyId === companyId) {
		const link = await linkFor(ctx, contractId);
		if (link?.currentView && link.companyId === companyId)
			await ctx.db.patch('buyerLinks', link._id, { currentView: null });
		await removeDirectoryEntry(ctx, contractId);
	}
	if (!marker && create) {
		const id = await ctx.db.insert('contractCleanups', {
			companyId,
			contractId,
			phase: 'deliveries',
			generation: 0
		});
		marker = await ctx.db.get('contractCleanups', id);
	}
	// A missing/foreign parent never grants access to another company's marker.
	if (marker?.companyId === companyId) await ensureScheduled(ctx, marker);
}

export const clean = internalMutation({
	args: { markerId: v.id('contractCleanups'), generation: v.number() },
	returns: v.null(),
	handler: async (ctx, { markerId, generation }) => {
		const marker = await ctx.db.get('contractCleanups', markerId);
		if (!marker || marker.generation !== generation) return null;
		const erasure = await companyDeletion(ctx, marker.companyId);
		if (erasure?.status === 'cleaning' || erasure?.status === 'complete') return null;
		if (await ctx.db.get('savedContracts', marker.contractId))
			throw new Error('Contract cleanup cannot drain a live contract.');

		const budget = cleanupBudget(ctx);
		const id = marker.contractId;
		let phase = marker.phase;
		let cursor = marker.cursor;
		let retryDelay = 0;

		while (!(await budget.exhausted())) {
			if (phase === 'deliveries') {
				const drained = await budget.drain(
					'emailDeliveries',
					ctx.db.query('emailDeliveries').withIndex('by_contractId', (q) => q.eq('contractId', id)),
					{
						beforeDelete: async (delivery) => {
							const retirement = await retireDelivery(ctx, delivery);
							if (retirement === 'ready') return true;
							retryDelay = RETIRED_DELIVERY_RECHECK;
							return false;
						}
					}
				);
				if (!drained) break;
				phase = 'buyerLinks';
				continue;
			}

			if (phase === 'buyerLinks') {
				const drained = await budget.drain(
					'buyerLinks',
					ctx.db.query('buyerLinks').withIndex('by_contractId', (q) => q.eq('contractId', id))
				);
				if (!drained) break;
				phase = 'buyerLinkShowings';
				continue;
			}

			if (phase === 'buyerLinkShowings') {
				const drained = await budget.drain(
					'buyerLinkBarShowings',
					ctx.db
						.query('buyerLinkBarShowings')
						.withIndex('by_contractId', (q) => q.eq('contractId', id))
				);
				if (!drained) break;
				phase = 'buyerActivity';
				continue;
			}

			if (phase === 'buyerActivity') {
				let drained = true;
				for (const table of [
					'buyerActivityReceipts',
					'buyerActivityOpenings',
					'buyerActivityCounters'
				] as const) {
					if (
						!(await budget.drain(
							table,
							ctx.db.query(table).withIndex('by_contractId', (q) => q.eq('contractId', id))
						))
					) {
						drained = false;
						break;
					}
				}
				if (!drained) break;
				phase = 'buyerQuotas';
				continue;
			}

			if (phase === 'buyerQuotas') {
				const drained = await budget.drain(
					'buyerActivityQuotaKeys',
					ctx.db
						.query('buyerActivityQuotaKeys')
						.withIndex('by_contractId', (q) => q.eq('contractId', id)),
					{ beforeDelete: (owner) => resetQuota(ctx, owner) }
				);
				if (!drained) break;
				phase = 'discussions';
				continue;
			}

			if (phase === 'discussions') {
				const quotas = await budget.drain(
					'discussionQuotaKeys',
					ctx.db
						.query('discussionQuotaKeys')
						.withIndex('by_contractId', (q) => q.eq('contractId', id)),
					{ beforeDelete: (owner) => resetQuota(ctx, owner) }
				);
				if (!quotas) break;
				let drained = true;
				for (const table of ['discussionMessages', 'discussionThreads'] as const) {
					if (
						!(await budget.drain(
							table,
							ctx.db.query(table).withIndex('by_contractId', (q) => q.eq('contractId', id))
						))
					) {
						drained = false;
						break;
					}
				}
				if (!drained) break;
				phase = 'exports';
				cursor = undefined;
				continue;
			}

			if (phase === 'exports') {
				const now = Date.now();
				const page = await ctx.db
					.query('wordExports')
					.withIndex('by_contractId', (q) => q.eq('contractId', id))
					.paginate({ cursor: cursor ?? null, numItems: 10 });
				for (const attempt of page.page) {
					const delivery = await exportDelivery(ctx, attempt);
					const events = await ctx.db
						.query('hubspotEvents')
						.withIndex('by_attemptId', (q) => q.eq('attemptId', attempt._id))
						.take(5);
					const uploadPending =
						Boolean(
							attempt.fileId &&
							delivery &&
							!delivery.remoteFileId &&
							(delivery.attachmentUntil ?? 0) > now
						) &&
						events.some((event) =>
							['pending', 'working', 'uncertain', 'blocked'].includes(event.status)
						);
					// Preserve rows needed by in-flight HubSpot attachment uploads; contractExports.expire cleans up their bytes.
					if (uploadPending) continue;
					if (delivery) await ctx.db.delete('hubspotExportDeliveries', delivery._id);
					await ctx.db.delete('wordExports', attempt._id);
					if (attempt.fileId) await deleteUnownedFile(ctx, attempt.fileId);
				}
				if (page.isDone) {
					phase = 'hubspotQuotes';
					cursor = undefined;
				} else {
					cursor = page.continueCursor;
				}
				break;
			}

			if (phase === 'hubspotQuotes') {
				let drained = true;
				for (const table of [
					'contractHubspotAssociations',
					'contractBuyerRefreshes',
					'hubspotLinkBlocks'
				] as const) {
					if (
						!(await budget.drain(
							table,
							ctx.db.query(table).withIndex('by_contractId', (q) => q.eq('contractId', id))
						))
					) {
						drained = false;
						break;
					}
				}
				if (!drained || (await budget.exhausted())) break;
				const page = await ctx.db
					.query('hubspotQuotePushes')
					.withIndex('by_contractId', (q) => q.eq('contractId', id))
					.paginate({ cursor: cursor ?? null, numItems: 10 });
				let waiting = false;
				for (const row of page.page) {
					if (row.state !== 'queued') continue;
					if (row.workId) await pool.cancel(ctx, row.workId as WorkId);
					if (quoteRunningUntil(row) > Date.now()) {
						retryDelay = 30_000;
						waiting = true;
						break;
					}
					await ctx.db.delete('hubspotQuotePushes', row._id);
					if (row.fileId) await deleteUnownedFile(ctx, row.fileId);
				}
				if (waiting) break;
				if (page.isDone) {
					// Preserve operationReceipts across individual contract deletion to maintain replay fences.
					await ctx.db.delete('contractCleanups', markerId);
					return null;
				}
				cursor = page.continueCursor;
				break;
			}
		}

		await schedule(ctx, marker, phase, retryDelay, cursor);
		return null;
	}
});

export const resumeOne = internalMutation({
	args: { markerId: v.id('contractCleanups') },
	returns: v.null(),
	handler: async (ctx, { markerId }) => {
		const marker = await ctx.db.get('contractCleanups', markerId);
		if (marker) await ensureScheduled(ctx, marker);
		return null;
	}
});

/** Independently discover cleanup after the parent and its caller have disappeared. */
export const resume = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	returns: v.null(),
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db
			.query('contractCleanups')
			.withIndex('by_creation_time')
			.paginate({ cursor: cursor ?? null, numItems: CLEANUP_DISCOVERY_PAGE_SIZE });
		for (const marker of result.page) {
			try {
				await ctx.runMutation(internal.contractCleanup.resumeOne, { markerId: marker._id });
			} catch (error) {
				console.error('Unable to resume contract cleanup', marker._id, error);
			}
		}
		if (!result.isDone)
			await ctx.scheduler.runAfter(0, internal.contractCleanup.resume, {
				cursor: result.continueCursor
			});
		return null;
	}
});
