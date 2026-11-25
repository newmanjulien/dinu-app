import { paginationResultValidator } from 'convex/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, internalQuery, type MutationCtx } from './_generated/server';
import { resetQuota } from './buyerActivityQuota';
import { CLEANUP_DISCOVERY_PAGE_SIZE, cleanupBudget } from './cleanup';
import { cleanupCompanyExports } from './contractExports';
import { cancelPreparationJobs } from './csmMeetingPreparation';
import { cancelAppointmentJobs } from './csmSetupAppointments';
import { clearSetupAppointment } from './csmSetupState';
import { DELETING_RECOVERY_DELAY, RECONCILIATION_PAGE_SIZE } from './deletionPolicy';
import { companyCleanupPhases as phases, deletingCompanyRecord } from './deletionValidators';
import { activeJob, cancelJob, RETIRED_DELIVERY_RECHECK, retireDelivery } from './emailDeliveries';
import { retireCompanyHubSpot } from './hubspotCleanup';
import { cleanupCompanyOperations } from './operationReceipts';
import { deleteUnownedFile } from './storageOwnership';

type Budget = ReturnType<typeof cleanupBudget>;
type Phase = (typeof phases)[number];
type PhaseResult = { drained: boolean; retryDelay?: number };

async function drainByCompany(
	ctx: MutationCtx,
	companyId: Id<'company'>,
	budget: Budget,
	tables: readonly (
		| 'buyerActivityReceipts'
		| 'buyerActivityOpenings'
		| 'buyerActivityCounters'
		| 'buyerLinks'
		| 'buyerLinkBarShowings'
		| 'discussionMessages'
		| 'discussionThreads'
		| 'savedContracts'
		| 'contractHubspotAssociations'
		| 'contractBuyerRefreshes'
		| 'playbookItems'
		| 'playbookItemCreationReceipts'
		| 'templateVersions'
		| 'currentTemplate'
		| 'playbookItemRevisions'
		| 'memberships'
	)[]
) {
	for (const table of tables) {
		if (
			!(await budget.drain(
				table,
				ctx.db.query(table).withIndex('by_companyId', (q) => q.eq('companyId', companyId))
			))
		)
			return false;
	}
	return true;
}

/**
 * Complete ordered company-erasure phases matching `deletionValidators.companyCleanupPhases`.
 * Covers all 44 company-scoped tables (9 HubSpot tables via `retireCompanyHubSpot` + 35 below);
 * only global/user-scoped tables (`profiles`, `deletedUsers`, `companyDeletions`, `fileSweeps`,
 * `hubspotJournal`, `hubspotPortalLifecycle`, `hubspotAccountRemovals`) are excluded.
 */
const phaseHandlers: Record<
	Exclude<Phase, 'company'>,
	(ctx: MutationCtx, companyId: Id<'company'>, budget: Budget) => Promise<PhaseResult>
> = {
	invitations: async (ctx, companyId, budget) => ({
		drained: await budget.drain(
			'companyInvitations',
			ctx.db
				.query('companyInvitations')
				.withIndex('by_companyId_and_status', (q) => q.eq('companyId', companyId)),
			{ beforeDelete: (row) => cancelJob(ctx, row.expiryJobId) }
		)
	}),
	hubspot: async (ctx, companyId, budget) => {
		const drained = await retireCompanyHubSpot(ctx, companyId, budget);
		return { drained, ...(drained ? {} : { retryDelay: 60_000 }) };
	},
	deliveries: async (ctx, companyId, budget) => {
		let retryDelay = 0;
		const drained = await budget.drain(
			'emailDeliveries',
			ctx.db
				.query('emailDeliveries')
				.withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
			{
				beforeDelete: async (row) => {
					if ((await retireDelivery(ctx, row)) === 'ready') return true;
					retryDelay = RETIRED_DELIVERY_RECHECK;
					return false;
				}
			}
		);
		return { drained, ...(retryDelay ? { retryDelay } : {}) };
	},
	contractCleanups: async (ctx, companyId, budget) => ({
		drained: await budget.drain(
			'contractCleanups',
			ctx.db
				.query('contractCleanups')
				.withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
			{ beforeDelete: (row) => cancelJob(ctx, row.jobId) }
		)
	}),
	operationReceipts: async (ctx, companyId, budget) => ({
		drained: await cleanupCompanyOperations(ctx, companyId, budget)
	}),
	exports: async (ctx, companyId, budget) => ({
		drained: await cleanupCompanyExports(ctx, companyId, budget)
	}),
	buyerActivity: async (ctx, companyId, budget) => ({
		drained:
			(await drainByCompany(ctx, companyId, budget, [
				'buyerActivityReceipts',
				'buyerActivityOpenings',
				'buyerActivityCounters'
			])) &&
			(await budget.drain(
				'buyerActivityQuotaKeys',
				ctx.db
					.query('buyerActivityQuotaKeys')
					.withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
				{ beforeDelete: (owner) => resetQuota(ctx, owner) }
			))
	}),
	buyerLinks: async (ctx, companyId, budget) => ({
		drained:
			(await drainByCompany(ctx, companyId, budget, ['buyerLinks', 'buyerLinkBarShowings'])) &&
			(await budget.drain(
				'buyerLinkShowingCleanups',
				ctx.db
					.query('buyerLinkShowingCleanups')
					.withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
				{ beforeDelete: (row) => cancelJob(ctx, row.jobId) }
			))
	}),
	discussions: async (ctx, companyId, budget) => ({
		drained:
			(await budget.drain(
				'discussionQuotaKeys',
				ctx.db
					.query('discussionQuotaKeys')
					.withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
				{ beforeDelete: (owner) => resetQuota(ctx, owner) }
			)) &&
			(await drainByCompany(ctx, companyId, budget, ['discussionMessages', 'discussionThreads']))
	}),
	contracts: async (ctx, companyId, budget) => ({
		drained:
			(await drainByCompany(ctx, companyId, budget, [
				'savedContracts',
				'contractHubspotAssociations',
				'contractBuyerRefreshes'
			])) &&
			(await budget.drain(
				'contractDirectory',
				ctx.db
					.query('contractDirectory')
					.withIndex('by_companyId_and_savedAt_and_createdAt', (q) => q.eq('companyId', companyId))
			))
	}),
	templateData: async (ctx, companyId, budget) => ({
		drained:
			(await budget.drain(
				'templateSourceCertificates',
				ctx.db
					.query('templateSourceCertificates')
					.withIndex('by_companyId_and_templateSourceId', (q) => q.eq('companyId', companyId))
			)) &&
			(await budget.drain(
				'templateSourceValidationChunks',
				ctx.db
					.query('templateSourceValidationChunks')
					.withIndex('by_companyId_and_templateSourceId_and_order', (q) =>
						q.eq('companyId', companyId)
					)
			)) &&
			(await budget.drain(
				'templateSourceChunks',
				ctx.db
					.query('templateSourceChunks')
					.withIndex('by_companyId_and_templateSourceId_and_order', (q) =>
						q.eq('companyId', companyId)
					)
			)) &&
			(await drainByCompany(ctx, companyId, budget, [
				'playbookItems',
				'playbookItemCreationReceipts',
				'templateVersions',
				'currentTemplate'
			])) &&
			(await budget.drain(
				'templateSources',
				ctx.db
					.query('templateSources')
					.withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
				{
					afterDelete: async (row) => {
						const company = await ctx.db.get('company', companyId);
						if (company?.pendingTemplateSourceId === row._id)
							await ctx.db.patch('company', companyId, { pendingTemplateSourceId: undefined });
						if (row.source === 'docx') await deleteUnownedFile(ctx, row.originalFileId);
					}
				}
			)) &&
			(await drainByCompany(ctx, companyId, budget, ['playbookItemRevisions']))
	}),
	csmBookings: async (ctx, companyId, budget) => ({
		drained:
			(await budget.drain(
				'csmMeetingPreparations',
				ctx.db
					.query('csmMeetingPreparations')
					.withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
				{ beforeDelete: (row) => cancelPreparationJobs(ctx, row) }
			)) &&
			(await budget.drain(
				'csmWebhookEvidence',
				ctx.db
					.query('csmWebhookEvidence')
					.withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
				{ beforeDelete: (row) => cancelJob(ctx, row.jobId) }
			)) &&
			(await budget.drain(
				'csmErasedInitialGuards',
				ctx.db
					.query('csmErasedInitialGuards')
					.withIndex('by_companyId_and_blocking', (q) => q.eq('companyId', companyId))
			)) &&
			(await budget.drain(
				'csmSetupAppointments',
				ctx.db
					.query('csmSetupAppointments')
					.withIndex('by_companyId_and_selection_and_sortAt_and_anchorUid', (q) =>
						q.eq('companyId', companyId)
					),
				{
					beforeDelete: async (row) => {
						await cancelAppointmentJobs(ctx, row);
						await clearSetupAppointment(ctx, row);
					}
				}
			)) &&
			(await budget.drain(
				'csmBookingAttempts',
				ctx.db
					.query('csmBookingAttempts')
					.withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
				{
					beforeDelete: async (row) => {
						await cancelJob(ctx, row.sendJobId);
						await cancelJob(ctx, row.watchdogJobId);
						await cancelJob(ctx, row.recoveryJobId);
					}
				}
			))
	}),
	memberships: async (ctx, companyId, budget) => ({
		drained: await drainByCompany(ctx, companyId, budget, ['memberships'])
	})
};

async function scheduleCleanup(
	ctx: MutationCtx,
	marker: Doc<'companyDeletions'>,
	delay = 0,
	nextPhase?: Phase
) {
	const generation = marker.cleanupGeneration + 1;
	const jobId = await ctx.scheduler.runAfter(delay, internal.companyDeletion.clean, {
		markerId: marker._id,
		generation
	});
	await ctx.db.patch('companyDeletions', marker._id, {
		...(nextPhase !== undefined && nextPhase !== marker.phase ? { phase: nextPhase } : {}),
		cleanupJobId: jobId,
		cleanupGeneration: generation
	});
}

async function ensureCleanup(ctx: MutationCtx, marker: Doc<'companyDeletions'>) {
	if (marker.status !== 'cleaning') return;
	if (!(await activeJob(ctx, marker.cleanupJobId))) await scheduleCleanup(ctx, marker);
}

// Only an explicit server-executed deletion hold authorizes company cleanup.
// External sole-owner account deletion without a hold stops for operator recovery.
export async function confirmAccountDeletion(ctx: MutationCtx, issuer: string, clerkId: string) {
	const marker = await ctx.db
		.query('companyDeletions')
		.withIndex('by_issuer_and_clerkId', (q) => q.eq('issuer', issuer).eq('clerkId', clerkId))
		.unique();
	if (!marker || marker.status === 'complete') return;
	if (marker.status === 'deleting') {
		const { _id, _creationTime, inFlight: _inFlight, ...base } = marker;
		const next = { ...base, status: 'cleaning' as const };
		await ctx.db.replace('companyDeletions', _id, next);
		await ensureCleanup(ctx, { _id, _creationTime, ...next });
		return;
	}
	await ensureCleanup(ctx, marker);
}

export const resumeOne = internalMutation({
	args: { markerId: v.id('companyDeletions') },
	returns: v.null(),
	handler: async (ctx, { markerId }) => {
		const marker = await ctx.db.get('companyDeletions', markerId);
		if (marker) await ensureCleanup(ctx, marker);
		return null;
	}
});

export const resume = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	returns: v.null(),
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db
			.query('companyDeletions')
			.withIndex('by_status_and_requestedAt', (q) => q.eq('status', 'cleaning'))
			.paginate({ cursor: cursor ?? null, numItems: CLEANUP_DISCOVERY_PAGE_SIZE });
		for (const marker of result.page) {
			try {
				await ctx.runMutation(internal.companyDeletion.resumeOne, { markerId: marker._id });
			} catch (error) {
				console.error('Unable to resume company deletion', marker._id, error);
			}
		}
		if (!result.isDone)
			await ctx.scheduler.runAfter(0, internal.companyDeletion.resume, {
				cursor: result.continueCursor
			});
		return null;
	}
});

export const pending = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: paginationResultValidator(deletingCompanyRecord),
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db
			.query('companyDeletions')
			.withIndex('by_status_and_requestedAt', (q) => q.eq('status', 'deleting'))
			.paginate({
				cursor,
				numItems: RECONCILIATION_PAGE_SIZE,
				maximumRowsRead: RECONCILIATION_PAGE_SIZE,
				maximumBytesRead: 2 * 1024 * 1024
			});
		return {
			...result,
			page: result.page.map(({ _id, executionId, requestedAt, issuer, clerkId }) => ({
				id: _id,
				executionId,
				requestedAt,
				issuer,
				clerkId
			}))
		};
	}
});

export const getDeleting = internalQuery({
	args: { id: v.id('companyDeletions') },
	returns: v.union(deletingCompanyRecord, v.null()),
	handler: async (ctx, { id }) => {
		const marker = await ctx.db.get('companyDeletions', id);
		if (!marker || marker.status !== 'deleting') return null;
		return {
			id: marker._id,
			executionId: marker.executionId,
			requestedAt: marker.requestedAt,
			issuer: marker.issuer,
			clerkId: marker.clerkId
		};
	}
});

export const releaseStaleDeleting = internalMutation({
	args: { id: v.id('companyDeletions'), executionId: v.string() },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const marker = await ctx.db.get('companyDeletions', args.id);
		if (
			!marker ||
			marker.status !== 'deleting' ||
			marker.executionId !== args.executionId ||
			marker.requestedAt + DELETING_RECOVERY_DELAY > Date.now()
		)
			return false;
		await ctx.db.delete('companyDeletions', marker._id);
		return true;
	}
});

export const clean = internalMutation({
	args: { markerId: v.id('companyDeletions'), generation: v.number() },
	returns: v.null(),
	handler: async (ctx, { markerId, generation }) => {
		const marker = await ctx.db.get('companyDeletions', markerId);
		if (!marker || marker.status !== 'cleaning' || marker.cleanupGeneration !== generation)
			return null;
		const companyId = marker.companyId;
		const budget = cleanupBudget(ctx);
		let phase: Phase = marker.phase;
		let retryDelay = 0;

		while (!(await budget.exhausted())) {
			if (phase === 'company') {
				const company = await ctx.db.get('company', companyId);
				if (company) await ctx.db.delete('company', companyId);
				if (company?.avatarId) await deleteUnownedFile(ctx, company.avatarId);
				// Membership validation rejects stale creation retries before receipt lookup.
				// The company tombstone remains permanently to reject delayed internal work.
				await ctx.db.patch('companyDeletions', markerId, {
					status: 'complete',
					phase,
					cleanupJobId: undefined
				});
				return null;
			}
			const result = await phaseHandlers[phase](ctx, companyId, budget);
			if (!result.drained) {
				retryDelay = result.retryDelay ?? 0;
				break;
			}
			phase = phases[phases.indexOf(phase) + 1];
		}

		await scheduleCleanup(ctx, marker, retryDelay, phase);
		return null;
	}
});
