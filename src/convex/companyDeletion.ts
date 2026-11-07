import { paginationResultValidator } from 'convex/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { internalMutation, internalQuery } from './_generated/server';
import { CLEANUP_DISCOVERY_PAGE_SIZE, cleanupBudget } from './cleanup';
import { PREPARATION_TTL, RECONCILIATION_PAGE_SIZE } from './deletionPolicy';
import { retireCompanyHubSpot } from './hubspotCleanup';
import { deletionIdentity, companyCleanupPhases as phases } from './deletionValidators';
import { cancelAppointmentJobs } from './csmSetupAppointments';
import { activeJob, cancelJob, RETIRED_DELIVERY_RECHECK } from './emailDeliveries';
import { retireDelivery } from './emailDisposal';
import { deleteUnownedFile } from './storageOwnership';

async function scheduleCleanup(ctx: MutationCtx, marker: Doc<'companyDeletions'>, delay = 0) {
	const generation = marker.cleanupGeneration + 1;
	const jobId = await ctx.scheduler.runAfter(delay, internal.companyDeletion.clean, {
		markerId: marker._id,
		generation
	});
	await ctx.db.patch('companyDeletions', marker._id, {
		cleanupJobId: jobId,
		cleanupGeneration: generation
	});
}
async function ensureCleanup(ctx: MutationCtx, marker: Doc<'companyDeletions'>) {
	if (marker.status !== 'cleaning') return;
	if (!(await activeJob(ctx, marker.cleanupJobId))) await scheduleCleanup(ctx, marker);
}
// Only a dispatched request authorizes company cleanup. An external account deletion
// during preparation expires the preparation and, if it was the sole owner, stops for
// an explicit operator handoff instead of silently orphaning company data.
export async function confirmAccountDeletion(ctx: MutationCtx, issuer: string, clerkId: string) {
	const marker = await ctx.db
		.query('companyDeletions')
		.withIndex('by_issuer_and_clerkId', (q) => q.eq('issuer', issuer).eq('clerkId', clerkId))
		.unique();
	if (!marker || marker.status === 'complete') return;
	if (marker.status === 'prepared') {
		await ctx.db.delete('companyDeletions', marker._id);
		return;
	}
	if (marker.status !== 'cleaning')
		await ctx.db.patch('companyDeletions', marker._id, { status: 'cleaning' });
	await ensureCleanup(ctx, { ...marker, status: 'cleaning' });
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
	returns: paginationResultValidator(deletionIdentity),
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db
			.query('companyDeletions')
			.withIndex('by_status_and_requestedAt', (q) => q.eq('status', 'dispatched'))
			.paginate({
				cursor,
				numItems: RECONCILIATION_PAGE_SIZE,
				maximumRowsRead: RECONCILIATION_PAGE_SIZE,
				maximumBytesRead: 2 * 1024 * 1024
			});
		return {
			...result,
			page: result.page.map(({ issuer, clerkId }) => ({ issuer, clerkId }))
		};
	}
});
export const expirePreparation = internalMutation({
	args: { id: v.id('companyDeletions'), attemptId: v.string(), requestedAt: v.number() },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const marker = await ctx.db.get('companyDeletions', args.id);
		if (
			!marker ||
			marker.status !== 'prepared' ||
			marker.attemptId !== args.attemptId ||
			marker.requestedAt !== args.requestedAt ||
			marker.requestedAt + PREPARATION_TTL > Date.now()
		)
			return false;
		await ctx.db.delete('companyDeletions', marker._id);
		return true;
	}
});
// Recover failed expiry jobs without any external lookup. Each conditional
// mutation checks the attempt and deadline again, so dispatch always wins safely.
export const expirePreparations = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	returns: v.null(),
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db
			.query('companyDeletions')
			.withIndex('by_status_and_requestedAt', (q) =>
				q.eq('status', 'prepared').lte('requestedAt', Date.now() - PREPARATION_TTL)
			)
			.paginate({
				cursor: cursor ?? null,
				numItems: 25,
				maximumRowsRead: 25,
				maximumBytesRead: 2 * 1024 * 1024
			});
		for (const marker of result.page) await ctx.db.delete('companyDeletions', marker._id);
		if (!result.isDone)
			await ctx.scheduler.runAfter(0, internal.companyDeletion.expirePreparations, {
				cursor: result.continueCursor
			});
		return null;
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
		const { exhausted, drain } = cleanupBudget(ctx);
		let phase = marker.phase;
		let retryDelay = 0;
		while (!(await exhausted())) {
			let drained: boolean;
			switch (phase) {
				case 'invitations':
					drained = await drain(
						'companyInvitations',
						ctx.db
							.query('companyInvitations')
							.withIndex('by_companyId_and_status', (q) => q.eq('companyId', companyId)),
						{ beforeDelete: (row) => cancelJob(ctx, row.expiryJobId) }
					);
					break;
				case 'hubspot':
					drained = await retireCompanyHubSpot(ctx, companyId);
					if (!drained) retryDelay = 60_000;
					break;
				case 'approvals':
					drained = await drain(
						'approvalRequests',
						ctx.db
							.query('approvalRequests')
							.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
					);
					break;
				case 'deliveries':
					drained = await drain(
						'emailDeliveries',
						ctx.db
							.query('emailDeliveries')
							.withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
						{
							beforeDelete: async (row) => {
								const retirement = await retireDelivery(ctx, row);
								if (retirement === 'ready') return true;
								if (retirement === 'inFlight') retryDelay = RETIRED_DELIVERY_RECHECK;
								return false;
							}
						}
					);
					break;
				case 'emailSelectionChunks':
					drained = await drain(
						'emailSelectionChunks',
						ctx.db
							.query('emailSelectionChunks')
							.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
					);
					break;
				case 'decisions':
					drained = await drain(
						'concessionDecisions',
						ctx.db
							.query('concessionDecisions')
							.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
					);
					break;
				case 'contracts':
					drained = await drain(
						'savedContracts',
						ctx.db
							.query('savedContracts')
							.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
					);
					break;
				case 'contractDirectory':
					drained = await drain(
						'contractDirectory',
						ctx.db
							.query('contractDirectory')
							.withIndex('by_companyId_and_savedAt_and_createdAt', (q) =>
								q.eq('companyId', companyId)
							)
					);
					break;
				case 'contractCleanups':
					drained = await drain(
						'contractCleanups',
						ctx.db
							.query('contractCleanups')
							.withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
						{ beforeDelete: (row) => cancelJob(ctx, row.jobId) }
					);
					break;
				case 'validationCertificates':
					drained = await drain(
						'baselineAuthoring',
						ctx.db
							.query('baselineAuthoring')
							.withIndex('by_companyId_and_baselineId', (q) => q.eq('companyId', companyId))
					);
					break;
				case 'validationFacts':
					drained = await drain(
						'baselineValidationChunks',
						ctx.db
							.query('baselineValidationChunks')
							.withIndex('by_companyId_and_baselineId_and_order', (q) =>
								q.eq('companyId', companyId)
							)
					);
					break;
				case 'authoringMigrations':
					drained = await drain(
						'authoringMigrations',
						ctx.db
							.query('authoringMigrations')
							.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
					);
					break;
				case 'blocks':
					drained = await drain(
						'baselineChunks',
						ctx.db
							.query('baselineChunks')
							.withIndex('by_companyId_and_baselineId_and_order', (q) =>
								q.eq('companyId', companyId)
							)
					);
					break;
				case 'items':
					drained = await drain(
						'playbookItems',
						ctx.db
							.query('playbookItems')
							.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
					);
					break;
				case 'itemReceipts':
					drained = await drain(
						'playbookItemCreationReceipts',
						ctx.db
							.query('playbookItemCreationReceipts')
							.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
					);
					break;
				case 'contractReceipts':
					drained = await drain(
						'contractCreationReceipts',
						ctx.db
							.query('contractCreationReceipts')
							.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
					);
					break;
				case 'versions':
					drained = await drain(
						'templateVersions',
						ctx.db
							.query('templateVersions')
							.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
					);
					break;
				case 'pointer':
					drained = await drain(
						'currentTemplate',
						ctx.db
							.query('currentTemplate')
							.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
					);
					break;
				case 'baselines':
					drained = await drain(
						'baselines',
						ctx.db
							.query('baselines')
							.withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
						{
							afterDelete: async (row) => {
								if (row.source === 'docx') await deleteUnownedFile(ctx, row.originalFileId);
							}
						}
					);
					break;
				case 'itemRevisions':
					drained = await drain(
						'playbookItemRevisions',
						ctx.db
							.query('playbookItemRevisions')
							.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
					);
					break;
				case 'csmBookings':
					drained =
						(await drain(
							'csmSetupAppointments',
							ctx.db
								.query('csmSetupAppointments')
								.withIndex('by_companyId_and_selection_and_sortAt_and_anchorUid', (q) =>
									q.eq('companyId', companyId)
								),
							{ beforeDelete: (row) => cancelAppointmentJobs(ctx, row) }
						)) &&
						(await drain(
							'csmBookingAttempts',
							ctx.db
								.query('csmBookingAttempts')
								.withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
							{
								beforeDelete: async (row) => {
									await cancelJob(ctx, row.sendJobId);
									await cancelJob(ctx, row.watchdogJobId);
								}
							}
						));
					break;
				case 'memberships':
					drained = await drain(
						'memberships',
						ctx.db
							.query('memberships')
							.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
					);
					break;
				case 'company': {
					if (!(await retireCompanyHubSpot(ctx, companyId))) {
						drained = false;
						retryDelay = 60_000;
						break;
					}
					// Workers already beyond a newly added phase must still drain its children.
					if (
						!(await drain(
							'csmSetupAppointments',
							ctx.db
								.query('csmSetupAppointments')
								.withIndex('by_companyId_and_selection_and_sortAt_and_anchorUid', (q) =>
									q.eq('companyId', companyId)
								),
							{ beforeDelete: (row) => cancelAppointmentJobs(ctx, row) }
						))
					) {
						drained = false;
						break;
					}
					if (
						!(await drain(
							'csmBookingAttempts',
							ctx.db.query('csmBookingAttempts').withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
							{ beforeDelete: async (row) => {
								await cancelJob(ctx, row.sendJobId);
								await cancelJob(ctx, row.watchdogJobId);
							} }
						))
					) {
						drained = false;
						break;
					}
					const authoringRowsDrained =
						(await drain(
							'baselineAuthoring',
							ctx.db
								.query('baselineAuthoring')
								.withIndex('by_companyId_and_baselineId', (q) => q.eq('companyId', companyId))
						)) &&
						(await drain(
							'baselineValidationChunks',
							ctx.db
								.query('baselineValidationChunks')
								.withIndex('by_companyId_and_baselineId_and_order', (q) =>
									q.eq('companyId', companyId)
								)
						)) &&
						(await drain(
							'authoringMigrations',
							ctx.db
								.query('authoringMigrations')
								.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
						));
					if (!authoringRowsDrained) {
						drained = false;
						break;
					}
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
			}
			if (!drained) break;
			phase = phases[phases.indexOf(phase) + 1];
		}
		if (phase !== marker.phase) await ctx.db.patch('companyDeletions', markerId, { phase });
		await scheduleCleanup(ctx, marker, retryDelay);
		return null;
	}
});
