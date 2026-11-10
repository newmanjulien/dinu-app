import { quoteRunningUntil } from './hubspotQuoteValidators';
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { activeJob, RETIRED_DELIVERY_RECHECK } from './emailDeliveries';
import { retireDelivery } from './emailDisposal';
import { pool } from './hubspotDelivery';
import { deleteUnownedFile } from './storageOwnership';
import { cleanupBudget, CLEANUP_DISCOVERY_PAGE_SIZE } from './cleanup';
import { resetQuota } from './buyerActivityQuota';

async function schedule(
	ctx: MutationCtx,
	marker: Doc<'contractCleanups'>,
	phase = marker.phase,
	delay = 0
) {
	const generation = marker.generation + 1;
	const jobId = await ctx.scheduler.runAfter(delay, internal.contractCleanup.clean, {
		markerId: marker._id,
		generation
	});
	await ctx.db.patch('contractCleanups', marker._id, { phase, generation, jobId });
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
	if (!marker && create) {
		const id = await ctx.db.insert('contractCleanups', {
			companyId,
			contractId,
			phase: 'decisions',
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
		const budget = cleanupBudget(ctx);
		const id = marker.contractId;
		let phase = marker.phase;
		let retryDelay = 0;
		if (phase === 'decisions') {
			if (
				await budget.drain(
					'concessionDecisions',
					ctx.db
						.query('concessionDecisions')
						.withIndex('by_contractId', (q) => q.eq('contractId', id))
				)
			)
				phase = 'deliveries';
		}
		if (phase === 'deliveries') {
			const drained = await budget.drain(
				'emailDeliveries',
				ctx.db.query('emailDeliveries').withIndex('by_contractId', (q) => q.eq('contractId', id)),
				{
					beforeDelete: async (delivery) => {
						const retirement = await retireDelivery(ctx, delivery);
						if (retirement === 'ready') return true;
						if (retirement === 'inFlight') retryDelay = RETIRED_DELIVERY_RECHECK;
						return false;
					}
				}
			);
			if (drained) phase = 'buyerActivity';
		}
		if (phase === 'buyerActivity') {
			let activityDrained = true;
			for (const table of [
				'buyerActivityReceipts',
				'buyerActivityClauses',
				'buyerActivityOpenings',
				'buyerActivityCounters'
			] as const) {
				if (
					!(await budget.drain(
						table,
						ctx.db.query(table).withIndex('by_contractId', (q) => q.eq('contractId', id))
					))
				) {
					activityDrained = false;
					break;
				}
			}
			const visits =
				activityDrained &&
				(await budget.drain(
					'buyerVisits',
					ctx.db
						.query('buyerVisits')
						.withIndex('by_contractId_and_lastAt', (q) => q.eq('contractId', id))
				));
			const opens =
				visits &&
				(await budget.drain(
					'buyerLinkOpens',
					ctx.db
						.query('buyerLinkOpens')
						.withIndex('by_contractId_and_at', (q) => q.eq('contractId', id))
				));
			const stats =
				opens &&
				(await budget.drain(
					'buyerLinkStats',
					ctx.db
						.query('buyerLinkStats')
						.withIndex('by_contractId_and_linkId', (q) => q.eq('contractId', id))
				));
			const browsers =
				stats &&
				(await budget.drain(
					'buyerLinkBrowsers',
					ctx.db
						.query('buyerLinkBrowsers')
						.withIndex('by_contractId_and_browserId', (q) => q.eq('contractId', id))
				));
			if (browsers) phase = 'buyerQuotas';
		}
		if (phase === 'buyerQuotas') {
			if (
				await budget.drain(
					'buyerActivityQuotaKeys',
					ctx.db
						.query('buyerActivityQuotaKeys')
						.withIndex('by_contractId', (q) => q.eq('contractId', id)),
					{
						beforeDelete: (owner) => resetQuota(ctx, owner)
					}
				)
			)
				phase = 'buyerLinks';
		}
		if (phase === 'buyerLinks') {
			if (
				await budget.drain(
					'buyerLinks',
					ctx.db.query('buyerLinks').withIndex('by_contractId', (q) => q.eq('contractId', id))
				)
			)
				phase = 'buyerState';
		}
		if (phase === 'buyerState') {
			if (
				await budget.drain(
					'contractBuyerState',
					ctx.db
						.query('contractBuyerState')
						.withIndex('by_contractId', (q) => q.eq('contractId', id))
				)
			)
				phase = 'discussions';
		}
		if (phase === 'discussions') {
			const quotas = await budget.drain(
				'discussionQuotaKeys',
				ctx.db
					.query('discussionQuotaKeys')
					.withIndex('by_contractId', (q) => q.eq('contractId', id)),
				{ beforeDelete: (owner) => resetQuota(ctx, owner) }
			);
			if (!quotas) {
				await schedule(ctx, marker, phase);
				return null;
			}
			let drained = true;
			for (const table of [
				'discussionMessages',
				'discussionThreads',
				'discussionReceipts',
				'proposalApplications',
				'contractConcessions',
				'publicationAcknowledgments',
				'contractAccess'
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
			if (drained) phase = 'hubspotQuotes';
		}
		if (phase === 'hubspotQuotes') {
			if (
				await budget.drain(
					'hubspotQuotePushes',
					ctx.db
						.query('hubspotQuotePushes')
						.withIndex('by_contractId', (q) => q.eq('contractId', id)),
					{
						beforeDelete: async (row) => {
							if (row.workId)
								await pool.cancel(ctx, row.workId as import('@convex-dev/workpool').WorkId);
							if (quoteRunningUntil(row) > Date.now()) {
								retryDelay = 30_000;
								return false;
							}
							return true;
						},
						afterDelete: async (row) => {
							if (row.fileId) await deleteUnownedFile(ctx, row.fileId);
						}
					}
				)
			) {
				await ctx.db.delete('contractCleanups', markerId);
				return null;
			}
		}
		await schedule(ctx, marker, phase, retryDelay);
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
