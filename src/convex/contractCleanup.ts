import { settleQuoteOutput } from './outputLifecycle';
import { revokeBuyerCurrentView } from './buyerCurrent';
import { removeDirectoryEntry } from './contractDirectory';
import { prepareRetention, retainedProvider } from './contractRetention';
import { companyDeletion } from './auth';
import {
	contractHasDocumentHold,
	scheduleContractCleanup as schedule,
	DOCUMENT_HOLD_RECHECK
} from './contractDocumentLifetime';
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

async function ensureScheduled(ctx: MutationCtx, marker: Doc<'contractCleanups'>) {
	if (marker.phase === 'waitingDocuments' && (await contractHasDocumentHold(ctx, marker))) {
		if (marker.waitingDueAt === undefined)
			await ctx.db.patch('contractCleanups', marker._id, {
				waitingDueAt: Date.now() + DOCUMENT_HOLD_RECHECK
			});
		return;
	}
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
		await revokeBuyerCurrentView(ctx, companyId, contractId);
		await removeDirectoryEntry(ctx, contractId);
	}
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
		// Company erasure owns its full set and must not compete with proof preflight.
		const erasure = await companyDeletion(ctx, marker.companyId);
		if (erasure?.status === 'cleaning' || erasure?.status === 'complete') return null;
		if (await ctx.db.get('savedContracts', marker.contractId))
			throw new Error('Contract cleanup cannot drain a live contract.');
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
			if (activityDrained) phase = 'buyerQuotas';
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
				if (row.format === 'full' && row.workId)
					await pool.cancel(ctx, row.workId as import('@convex-dev/workpool').WorkId);
				if (row.format === 'full' && quoteRunningUntil(row) > Date.now()) {
					await schedule(ctx, marker, phase, 30_000);
					return null;
				}
				if (row.format === 'compact' || (await retainedProvider(ctx, row._id))) {
					// Keep factual dispatch/claim/outcome for observation and late settlement.
					if (row.state === 'queued')
						await ctx.db.patch('hubspotQuotePushes', row._id, {
							state: 'retired',
							workId: undefined,
							claim: undefined,
							leaseUntil: undefined,
							dueAt: undefined
						});
					await settleQuoteOutput(ctx, row._id);
				} else {
					await ctx.db.delete('hubspotQuotePushes', row._id);
					if (row.format === 'full')
						for (const fileId of [row.fileId, row.deletingFileId])
							if (fileId) await deleteUnownedFile(ctx, fileId);
				}
			}
			await ctx.db.patch('contractCleanups', markerId, {
				providerCursor: page.isDone ? undefined : page.continueCursor
			});
			await schedule(ctx, marker, page.isDone ? 'waitingDocuments' : phase);
			return null;
		}
		if (phase === 'waitingDocuments' || phase === 'documents' || phase === 'documentChunks') {
			// Admission cannot add a new full owner after root deletion. The indexed range
			// conflicts with acquisition/release in this transaction, including final wakeup.
			if (await contractHasDocumentHold(ctx, marker)) {
				if (phase !== 'waitingDocuments')
					throw new Error('A document hold appeared after document drain began.');
				await ctx.db.patch('contractCleanups', markerId, {
					phase: 'waitingDocuments',
					jobId: undefined,
					waitingDueAt: Date.now() + DOCUMENT_HOLD_RECHECK
				});
				return null;
			}
			if (phase === 'waitingDocuments') phase = 'documents';
		}
		if (phase === 'documents') {
			// Shared chunks are never deleted by manifest: first remove every manifest,
			// then drain the complete contract chunk range after the final full hold.
			if (
				await budget.drain(
					'contractDocuments',
					ctx.db
						.query('contractDocuments')
						.withIndex('by_contractId', (q) => q.eq('contractId', id))
				)
			)
				phase = 'documentChunks';
		}
		if (
			phase === 'documentChunks' &&
			(await budget.drain(
				'contractDocumentChunks',
				ctx.db
					.query('contractDocumentChunks')
					.withIndex('by_contractId', (q) => q.eq('contractId', id))
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
