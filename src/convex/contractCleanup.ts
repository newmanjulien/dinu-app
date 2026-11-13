import { revokeBuyerCurrentView } from './buyerCurrent';
import { prepareRetention, retainedDocument, retainedProvider } from './contractRetention';
import { quoteRunningUntil } from './hubspotQuoteValidators';
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { activeJob, cancelJob, RETIRED_DELIVERY_RECHECK } from './emailDeliveries';
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
	if (create || marker?.companyId === companyId)
		await revokeBuyerCurrentView(ctx, companyId, contractId);
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
		if (!(await prepareRetention(ctx, marker))) {
			await schedule(ctx, (await ctx.db.get('contractCleanups', markerId))!);
			return null;
		}
		const budget = cleanupBudget(ctx);
		const id = marker.contractId;
		let phase = marker.phase;
		let retryDelay = 0;
		if (phase === 'decisions') {
			for (const table of [
				'contractChangeHeads',
				'contractChangeDecisions',
				'contractChangeContents',
				'contractChanges'
			] as const) {
				if (
					!(await budget.drain(
						table,
						ctx.db.query(table).withIndex('by_contractId', (q) => q.eq('contractId', id))
					))
				) {
					await schedule(ctx, marker, phase);
					return null;
				}
			}
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
				phase = 'discussions';
		}
		if (phase === 'discussions') {
			const control = await ctx.db
				.query('discussionUnreadControls')
				.withIndex('by_contractId', (q) => q.eq('contractId', id))
				.unique();
			if (control) await cancelJob(ctx, control.jobId);
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
				'approvalRequests',
				'discussionInvalidations',
				'discussionTransitionMapChunks',
				'discussionUnreadNodes',
				'discussionUnreadControls',
				'discussionPassageClaims'
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
					await schedule(ctx, marker, phase);
					return null;
				}
			}
			const page = await ctx.db
				.query('hubspotQuotePushes')
				.withIndex('by_contractId', (q) => q.eq('contractId', id))
				.paginate({ cursor: marker.providerCursor ?? null, numItems: 1 });
			for (const row of page.page) {
				if (row.workId) await pool.cancel(ctx, row.workId as import('@convex-dev/workpool').WorkId);
				if (quoteRunningUntil(row) > Date.now()) {
					await schedule(ctx, marker, phase, 30_000);
					return null;
				}
				if (await retainedProvider(ctx, row._id)) {
					// Keep factual dispatch/claim/outcome for observation and late settlement.
					if (row.state === 'queued')
						await ctx.db.patch('hubspotQuotePushes', row._id, {
							state: 'retired',
							workId: undefined,
							dueAt: undefined
						});
				} else {
					await ctx.db.delete('hubspotQuotePushes', row._id);
					if (row.fileId) await deleteUnownedFile(ctx, row.fileId);
				}
			}
			await ctx.db.patch('contractCleanups', markerId, {
				providerCursor: page.isDone ? undefined : page.continueCursor
			});
			await schedule(ctx, marker, page.isDone ? 'documents' : phase);
			return null;
		}
		if (phase === 'documents') {
			// Retained output operations outlive the contract. Mark each shared chunk in
			// bounded batches before the final sweep; never load document contents here.
			if (await budget.exhausted()) {
				await schedule(ctx, marker, phase);
				return null;
			}
			const page = marker.documentId
				? null
				: await ctx.db
						.query('contractDocuments')
						.withIndex('by_contractId', (q) => q.eq('contractId', id))
						.paginate({ cursor: marker.documentCursor ?? null, numItems: 1 });
			const document = marker.documentId
				? await ctx.db.get('contractDocuments', marker.documentId)
				: page?.page[0];
			if (document) {
				const retained = await retainedDocument(ctx, document._id);
				let offset = marker.chunkOffset ?? 0;
				if (retained) {
					const end = Math.min(offset + 20, document.chunkIds.length);
					for (; offset < end; offset++) {
						const chunk = await ctx.db.get('contractDocumentChunks', document.chunkIds[offset]);
						if (!chunk || chunk.contractId !== id || chunk.companyId !== marker.companyId)
							throw new Error('Retained contract document has invalid chunks.');
						if (!chunk.retainedAfterDeletion)
							await ctx.db.patch('contractDocumentChunks', chunk._id, {
								retainedAfterDeletion: true
							});
					}
				} else await ctx.db.delete('contractDocuments', document._id);
				const incomplete = retained && offset < document.chunkIds.length;
				await ctx.db.patch('contractCleanups', markerId, {
					documentId: incomplete ? document._id : undefined,
					chunkOffset: incomplete ? offset : undefined,
					documentCursor: page?.continueCursor ?? marker.documentCursor,
					documentScanDone: page?.isDone ?? marker.documentScanDone
				});
				// Finish a final partial mark before sweeping; never reuse an exhausted cursor.
				if (!incomplete && (page?.isDone ?? marker.documentScanDone)) phase = 'documentChunks';
				await schedule(ctx, marker, phase);
				return null;
			}
			phase = 'documentChunks';
		}
		if (
			phase === 'documentChunks' &&
			(await budget.drain(
				'contractDocumentChunks',
				ctx.db
					.query('contractDocumentChunks')
					.withIndex('by_contractId_and_retainedAfterDeletion', (q) =>
						q.eq('contractId', id).eq('retainedAfterDeletion', undefined)
					)
			))
		) {
			await ctx.db.delete('contractCleanups', markerId);
			return null;
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
