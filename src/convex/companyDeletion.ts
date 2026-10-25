import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { Doc, TableNames } from './_generated/dataModel';
import { internal } from './_generated/api';
import { cancelDelivery, cancelJob } from './emailDeliveries';
import { deleteSelections } from './emailSnapshots';

export const PREPARATION_TTL = 15 * 60_000;
const phases = [
	'invitations',
	'approvals',
	'notifications',
	'deliveries',
	'emailSnapshots',
	'reviewAttributions',
	'decisions',
	'contracts',
	'contractDirectory',
	'blocks',
	'items',
	'snapshotItems',
	'itemReceipts',
	'contractReceipts',
	'versions',
	'pointer',
	'baselines',
	'itemRevisions',
	'delegationAttachments',
	'delegationRequests',
	'delegationCancellations',
	'memberships',
	'company'
] as const satisfies readonly Doc<'companyDeletions'>['phase'][];

async function scheduleCleanup(ctx: MutationCtx, marker: Doc<'companyDeletions'>) {
	const generation = (marker.cleanupGeneration ?? 0) + 1;
	const jobId = await ctx.scheduler.runAfter(0, internal.companyDeletion.clean, {
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
	const job = marker.cleanupJobId
		? await ctx.db.system.get('_scheduled_functions', marker.cleanupJobId)
		: null;
	if (job?.state.kind === 'pending' || job?.state.kind === 'inProgress') return;
	await scheduleCleanup(ctx, marker);
}
// Only a dispatched request authorizes company cleanup. External account deletion
// during preparation instead follows normal account cleanup and ownership recovery.
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
			.withIndex('by_status', (q) => q.eq('status', 'cleaning'))
			.paginate({ cursor: cursor ?? null, numItems: 10 });
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
	returns: v.object({
		page: v.array(v.object({ issuer: v.string(), clerkId: v.string() })),
		cursor: v.string(),
		done: v.boolean()
	}),
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db
			.query('companyDeletions')
			.withIndex('by_status', (q) => q.eq('status', 'dispatched'))
			.paginate({ cursor, numItems: 25 });
		return {
			page: result.page.map(({ issuer, clerkId }) => ({ issuer, clerkId })),
			cursor: result.continueCursor,
			done: result.isDone
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
			.withIndex('by_status', (q) => q.eq('status', 'prepared'))
			.paginate({ cursor: cursor ?? null, numItems: 25 });
		for (const marker of result.page)
			if (marker.requestedAt + PREPARATION_TTL <= Date.now())
				await ctx.db.delete('companyDeletions', marker._id);
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
		let count = 0;
		const exhausted = async () => {
			const metrics = await ctx.meta.getTransactionMetrics();
			// One budget across all phases; leave room for a full-size next row,
			// approval cancellation, progress, and the single continuation.
			return (
				count >= 100 ||
				metrics.bytesRead.remaining < 4_000_000 ||
				metrics.bytesWritten.remaining < 4_000_000 ||
				metrics.databaseQueries.remaining < 64 ||
				metrics.documentsRead.remaining < 64 ||
				metrics.documentsWritten.remaining < 64 ||
				metrics.functionsScheduled.remaining < 1
			);
		};
		async function drain<Table extends TableNames>(
			table: Table,
			rows: AsyncIterable<Doc<Table>>,
			beforeDelete?: (row: Doc<Table>) => Promise<void>
		) {
			for await (const row of rows) {
				await beforeDelete?.(row);
				await ctx.db.delete(table, row._id);
				count++;
				if (await exhausted()) return false;
			}
			return true;
		}
		let phase = marker.phase;
		while (!(await exhausted())) {
			let drained: boolean;
			switch (phase) {
				case 'invitations':
					drained = await drain(
						'companyInvitations',
						ctx.db
							.query('companyInvitations')
							.withIndex('by_companyId_and_status', (q) => q.eq('companyId', companyId)),
						(row) => cancelJob(ctx, row.expiryJobId)
					);
					break;
				case 'approvals':
					drained = await drain(
						'approvalRequests',
						ctx.db
							.query('approvalRequests')
							.withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
						async (row) => {
							if (!('deliveryId' in row)) await cancelJob(ctx, row.sendJobId);
						}
					);
					break;
				case 'notifications':
					drained = await drain(
						'decisionNotifications',
						ctx.db
							.query('decisionNotifications')
							.withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
						async (row) => {
							await cancelJob(ctx, row.sendJobId);
							await cancelJob(ctx, row.recoveryJobId);
						}
					);
					break;
				case 'deliveries':
					drained = await drain(
						'emailDeliveries',
						ctx.db
							.query('emailDeliveries')
							.withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
						async (row) => {
							await cancelDelivery(ctx, row);
							await deleteSelections(ctx, row._id);
						}
					);
					break;
				case 'emailSnapshots':
					drained = await drain(
						'emailSnapshots',
						ctx.db
							.query('emailSnapshots')
							.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
					);
					break;
				case 'reviewAttributions':
					drained = await drain(
						'reviewAttributions',
						ctx.db
							.query('reviewAttributions')
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
							.withIndex('by_companyId_and_savedAt', (q) => q.eq('companyId', companyId))
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
				case 'blocks':
					drained = await drain(
						'contractBlocks',
						ctx.db
							.query('contractBlocks')
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
				case 'snapshotItems':
					drained = await drain(
						'templateVersionItems',
						ctx.db
							.query('templateVersionItems')
							.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
					);
					break;
				case 'itemReceipts':
					drained = await drain(
						'creationReceipts',
						ctx.db
							.query('creationReceipts')
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
						async (row) => {
							if (row.originalFileId) await ctx.storage.delete(row.originalFileId);
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
				case 'delegationAttachments':
					drained = await drain(
						'delegationAttachments',
						ctx.db
							.query('delegationAttachments')
							.withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
						async (row) => {
							await ctx.storage.delete(row.storageId);
						}
					);
					break;
				case 'delegationRequests':
					drained = await drain(
						'delegationRequests',
						ctx.db
							.query('delegationRequests')
							.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
					);
					break;
				case 'delegationCancellations':
					drained = await drain(
						'delegationCancellations',
						ctx.db
							.query('delegationCancellations')
							.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
					);
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
					const company = await ctx.db.get('company', companyId);
					if (company?.avatarId) await ctx.storage.delete(company.avatarId);
					if (company) await ctx.db.delete('company', companyId);
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
		await scheduleCleanup(ctx, marker);
		return null;
	}
});
