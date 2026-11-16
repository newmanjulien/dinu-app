import { internal } from './_generated/api';
import { v, type Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { cleanupBudget } from './cleanup';
import { activeJob } from './emailDeliveries';
import { retireSnapshotDelivery } from './emailDisposal';
import { expireOperation } from './operationExpiry';
import { operation, receiptDeadline } from './operationReceipts';
import { retireOutputPreparation } from './outputReservations';
import { compactOutput } from './outputLifecycle';
import { recoverWaitingContractCleanups } from './contractDocumentLifetime';
import { retentionTarget } from './retentionValidators';

const RECHECK = 60 * 60_000;
type Target = Infer<typeof retentionTarget>;
type Sweep = Doc<'retentionSweeps'>;
const phases = ['operations', 'creations', 'discussions', 'outputs'] as const;

function deadlines(row: { retryUntil: number; gcAfter: number }, identity: string) {
	const original = operation(identity);
	if (row.retryUntil !== original.retryUntil || row.gcAfter !== original.gcAfter)
		throw new Error('Receipt retention deadlines changed.');
}

/** Complete snapshots own their evidence and execution independently. Staging work
 * must finish its real disposal, including any in-flight provider outcome. */
async function releaseEmail(ctx: MutationCtx, row: Doc<'operationReceipts'>) {
	const linked = await ctx.db
		.query('emailDeliveries')
		.withIndex('by_snapshot_receiptId', (q) => q.eq('snapshot.receiptId', row._id))
		.first();
	const delivery =
		linked ??
		(row.emailPreparation
			? await ctx.db.get('emailDeliveries', row.emailPreparation.deliveryId)
			: null);
	if (delivery) {
		if (
			!('snapshot' in delivery) ||
			delivery.companyId !== row.companyId ||
			delivery.contractId !== row.contractId ||
			delivery.snapshot.ownerKey !== row.key ||
			delivery.snapshot.operationId !== row.operationId ||
			(delivery.snapshot.receiptId !== undefined && delivery.snapshot.receiptId !== row._id) ||
			(row.emailPreparation &&
				(row.emailPreparation.deliveryId !== delivery._id ||
					row.emailPreparation.generation !== delivery.snapshot.generation))
		)
			throw new Error('Receipt email dependency changed.');
		if (delivery.snapshot.state === 'staging') {
			if (delivery.snapshot.receiptId !== row._id || delivery.state.kind === 'sent')
				throw new Error('Private email snapshot lost its original owner.');
			await retireSnapshotDelivery(ctx, delivery);
			await ctx.runMutation(internal.emailDisposal.resumeOne, { id: delivery._id });
			return false;
		}
		if (linked)
			await ctx.db.patch('emailDeliveries', delivery._id, {
				snapshot: { ...delivery.snapshot, receiptId: undefined }
			});
	}
	if (row.emailPreparation)
		await ctx.db.patch('operationReceipts', row._id, { emailPreparation: undefined });
	// A malformed second link must retain the receipt, even after the first moved.
	return !(await ctx.db
		.query('emailDeliveries')
		.withIndex('by_snapshot_receiptId', (q) => q.eq('snapshot.receiptId', row._id))
		.first());
}

async function collectOperation(ctx: MutationCtx, id: Id<'operationReceipts'>, now: number) {
	const row = await ctx.db.get('operationReceipts', id);
	if (!row || row.gcAfter > now) return;
	const original = receiptDeadline(row.key);
	deadlines(row, original.operationId);
	if (
		(row.operationId !== undefined && row.operationId !== original.operationId) ||
		!Number.isSafeInteger(row.executionUntil) ||
		row.executionUntil > row.retryUntil
	)
		throw new Error('Receipt execution identity changed.');
	if (row.state === 'preparing') {
		if (row.outputId) {
			const output = await ctx.db.get('contractOutputs', row.outputId);
			if (
				output?.format !== 'full' ||
				output.receiptId !== row._id ||
				output.companyId !== row.companyId ||
				output.contractId !== row.contractId
			)
				throw new Error('Pending receipt lost its private output owner.');
		}
		await expireOperation(ctx, row);
		return;
	}
	if (row.preparation) throw new Error('Terminal receipt still owns active preparation.');
	const output = await ctx.db
		.query('contractOutputs')
		.withIndex('by_receiptId', (q) => q.eq('receiptId', row._id))
		.first();
	if (output) throw new Error('Terminal receipt still owns private output work.');
	if (!(await releaseEmail(ctx, row))) return;
	// Preserve the exact seal through actual-owner promotion, private drain and sections.
	if ((await ctx.runMutation(internal.nativeConstructionCleanup.dispose, { receiptId: id })) !== 'ready') return;
	const budget = cleanupBudget(ctx);
	if (await budget.exhausted()) return;
	if (!row.collecting) await ctx.db.patch('operationReceipts', id, { collecting: true });
	const chunks = await ctx.db
		.query('operationReceiptChunks')
		.withIndex('by_receiptId_and_section_and_generation_and_order', (q) => q.eq('receiptId', id))
		.take(8);
	for (const chunk of chunks)
		if (chunk.companyId !== row.companyId || chunk.section !== 'payload' || chunk.generation !== 0)
			throw new Error('Receipt replay disposal found an unreleased section.');
	async function* batch() {
		yield* chunks;
	}
	if (!(await budget.drain('operationReceiptChunks', batch()))) return;
	if (
		await ctx.db
			.query('operationReceiptChunks')
			.withIndex('by_receiptId_and_section_and_generation_and_order', (q) => q.eq('receiptId', id))
			.first()
	)
		return;
	await ctx.db.delete('operationReceipts', id);
}

/** One bounded owner turn. A nested failure rolls back only that owner, so the
 * traversal advances and preserves its evidence for a later recovery cycle. */
export const collect = internalMutation({
	args: { target: retentionTarget, capturedNow: v.number() },
	returns: v.null(),
	handler: async (ctx, { target, capturedNow }) => {
		if (target.kind === 'operations') await collectOperation(ctx, target.id, capturedNow);
		else if (target.kind === 'creations') {
			const row = await ctx.db.get('contractCreationReceipts', target.id);
			if (row && row.gcAfter <= capturedNow) {
				const separator = row.operationId.indexOf(':'),
					membershipId = row.operationId.slice(0, separator);
				// Validate the stored namespace even after its membership has been erased.
				if (separator <= 0 || ctx.db.normalizeId('memberships', membershipId) !== membershipId)
					throw new Error('Invalid creation receipt membership scope.');
				deadlines(row, row.operationId.slice(separator + 1));
				await ctx.db.delete('contractCreationReceipts', row._id);
			}
		} else if (target.kind === 'discussions') {
			const row = await ctx.db.get('discussionReceipts', target.id);
			if (row && row.gcAfter <= capturedNow) {
				deadlines(row, row.operationId);
				// Messages, current discussions and meaningful tombstones retain their owners.
				await ctx.db.delete('discussionReceipts', row._id);
			}
		} else {
			const row = await ctx.db.get('contractOutputs', target.id);
			if (row?.format !== 'full' || row.retentionDueAt > capturedNow) return null;
			if (row.receiptId) {
				const receipt = await ctx.db.get('operationReceipts', row.receiptId);
				if (
					!receipt ||
					receipt.state !== 'preparing' ||
					receipt.outputId !== row._id ||
					receipt.companyId !== row.companyId ||
					receipt.contractId !== row.contractId
				)
					throw new Error('Private output lost its original receipt.');
				if (receipt.executionUntil <= capturedNow) await expireOperation(ctx, receipt);
			} else if (row.outputPreparation && row.executionUntil <= capturedNow)
				await retireOutputPreparation(ctx, row, 'This operation expired.', 'OPERATION_EXPIRED');
			// This derives immutable settlement, checks every independent hold, and
			// drains at most eight proof chunks. It never schedules or infers failure.
			else await compactOutput(ctx, row._id, capturedNow);
		}
		return null;
	}
});

async function schedule(ctx: MutationCtx, sweep: Sweep) {
	const version = sweep.version + 1;
	const jobId = await ctx.scheduler.runAfter(0, internal.retentionMaintenance.run, { version });
	await ctx.db.patch('retentionSweeps', sweep._id, { version, jobId });
}

/** Hourly recovery repairs lost callbacks without replacing their captured cutoff. */
export const pump = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const capturedNow = Date.now(),
			budget = cleanupBudget(ctx);
		let sweep = await ctx.db
			.query('retentionSweeps')
			.withIndex('by_name', (q) => q.eq('name', 'contracts'))
			.unique();
		if (!sweep) {
			const id = await ctx.db.insert('retentionSweeps', {
				name: 'contracts',
				version: 0,
				dueAt: capturedNow,
				capturedNow,
				phase: 'operations',
				cursor: null
			});
			sweep = await ctx.db.get('retentionSweeps', id);
		}
		if (
			sweep &&
			!(await activeJob(ctx, sweep.jobId)) &&
			(sweep.capturedNow !== undefined || sweep.dueAt <= capturedNow)
		) {
			if (sweep.capturedNow === undefined)
				await ctx.db.patch('retentionSweeps', sweep._id, {
					capturedNow,
					phase: 'operations',
					cursor: null
				});
			await schedule(ctx, sweep);
		}
		// Reserve the sweep's durable continuation before bounded waiting recovery.
		if (!(await budget.exhausted())) await recoverWaitingContractCleanups(ctx, capturedNow, budget);
		return null;
	}
});

/** One indexed page and one owner per transaction leave explicit parent headroom.
 * Held/pending work stays behind this cursor until the next hourly cycle. */
export const run = internalMutation({
	args: { version: v.number() },
	returns: v.null(),
	handler: async (ctx, { version }) => {
		const sweep = await ctx.db
			.query('retentionSweeps')
			.withIndex('by_name', (q) => q.eq('name', 'contracts'))
			.unique();
		if (!sweep || sweep.version !== version || sweep.capturedNow === undefined) return null;
		const capturedNow = sweep.capturedNow;
		const pagination = {
			cursor: sweep.cursor,
			numItems: 1,
			maximumRowsRead: 1,
			maximumBytesRead: 1_100_000
		};
		let target: Target | undefined, isDone: boolean, continueCursor: string;
		if (sweep.phase === 'operations') {
			const page = await ctx.db
				.query('operationReceipts')
				.withIndex('by_gcAfter', (q) => q.gte('gcAfter', 0).lte('gcAfter', capturedNow))
				.paginate(pagination);
			if (page.page[0]) target = { kind: sweep.phase, id: page.page[0]._id };
			({ isDone, continueCursor } = page);
		} else if (sweep.phase === 'creations') {
			const page = await ctx.db
				.query('contractCreationReceipts')
				.withIndex('by_gcAfter', (q) => q.gte('gcAfter', 0).lte('gcAfter', capturedNow))
				.paginate(pagination);
			if (page.page[0]) target = { kind: sweep.phase, id: page.page[0]._id };
			({ isDone, continueCursor } = page);
		} else if (sweep.phase === 'discussions') {
			const page = await ctx.db
				.query('discussionReceipts')
				.withIndex('by_gcAfter', (q) => q.gte('gcAfter', 0).lte('gcAfter', capturedNow))
				.paginate(pagination);
			if (page.page[0]) target = { kind: sweep.phase, id: page.page[0]._id };
			({ isDone, continueCursor } = page);
		} else {
			const page = await ctx.db
				.query('contractOutputs')
				.withIndex('by_retentionDueAt', (q) =>
					q.gte('retentionDueAt', 0).lte('retentionDueAt', capturedNow)
				)
				.paginate(pagination);
			if (page.page[0]) target = { kind: sweep.phase, id: page.page[0]._id };
			({ isDone, continueCursor } = page);
		}
		if (target) {
			const metrics = await ctx.meta.getTransactionMetrics();
			try {
				await ctx.runMutation(
					internal.retentionMaintenance.collect,
					{ target, capturedNow },
					{
						transactionLimits: {
							bytesRead: Math.max(1, metrics.bytesRead.remaining - 4_000_000),
							bytesWritten: Math.max(1, metrics.bytesWritten.remaining - 4_000_000),
							databaseQueries: Math.max(1, metrics.databaseQueries.remaining - 64),
							documentsRead: Math.max(1, metrics.documentsRead.remaining - 64),
							documentsWritten: Math.max(1, metrics.documentsWritten.remaining - 64),
							functionsScheduled: Math.max(1, metrics.functionsScheduled.remaining - 2),
							scheduledFunctionArgsBytes: Math.max(
								1,
								metrics.scheduledFunctionArgsBytes.remaining - 2048
							)
						}
					}
				);
			} catch (error) {
				console.error('Retention owner remains held', target.kind, target.id, error);
			}
		}
		const next = phases[phases.indexOf(sweep.phase) + 1];
		if (isDone && !next) {
			await ctx.db.patch('retentionSweeps', sweep._id, {
				capturedNow: undefined,
				phase: 'operations',
				cursor: null,
				jobId: undefined,
				dueAt: capturedNow + RECHECK
			});
		} else {
			await ctx.db.patch('retentionSweeps', sweep._id, {
				phase: isDone ? next : sweep.phase,
				cursor: isDone ? null : continueCursor
			});
			await schedule(ctx, sweep);
		}
		return null;
	}
});
