import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { activeJob } from './emailDeliveries';
const runRef = makeFunctionReference<'mutation', { receiptId: Id<'operationReceipts'> }, null>(
	'outputProofCleanup:run'
);
export async function queueOutputProofCleanup(
	ctx: MutationCtx,
	receiptId: Id<'operationReceipts'>,
	through: number
) {
	const row = await ctx.db.get('operationReceipts', receiptId);
	if (!row || through < 0) return;
	const cleanup = row.outputCleanup
		? { ...row.outputCleanup, through: Math.max(row.outputCleanup.through, through) }
		: {
				generation: 0,
				through,
				dueAt: Date.now(),
				jobId: undefined as Id<'_scheduled_functions'> | undefined
			};
	if (!(await activeJob(ctx, cleanup.jobId)))
		cleanup.jobId = await ctx.scheduler.runAfter(0, runRef, { receiptId });
	await ctx.db.patch('operationReceipts', receiptId, { outputCleanup: cleanup });
}
export const run = internalMutation({
	args: { receiptId: v.id('operationReceipts') },
	returns: v.null(),
	handler: async (ctx, { receiptId }) => {
		const row = await ctx.db.get('operationReceipts', receiptId);
		if (!row?.outputCleanup) return null;
		const progress = { ...row.outputCleanup };
		if (
			row.reservationManifest?.proof.generation === progress.generation ||
			row.outputPreparation?.generation === progress.generation
		)
			progress.generation++;
		if (progress.generation > progress.through) {
			await ctx.db.patch('operationReceipts', receiptId, { outputCleanup: undefined });
			return null;
		}
		const chunks = await ctx.db
			.query('operationReceiptChunks')
			.withIndex('by_receiptId_and_section_and_generation_and_order', (q) =>
				q
					.eq('receiptId', receiptId)
					.eq('section', 'output-proof')
					.gte('generation', progress.generation)
					.lte('generation', progress.through)
			)
			.take(8);
		for (const chunk of chunks) {
			if (chunk.companyId !== row.companyId) throw new Error('Output garbage owner changed.');
			if (
				chunk.generation === row.reservationManifest?.proof.generation ||
				chunk.generation === row.outputPreparation?.generation
			) {
				progress.generation = chunk.generation + 1;
				break;
			}
			await ctx.db.delete('operationReceiptChunks', chunk._id);
			progress.generation = chunk.generation;
		}
		if (!chunks.length) {
			await ctx.db.patch('operationReceipts', receiptId, { outputCleanup: undefined });
			return null;
		}
		progress.dueAt = Date.now();
		progress.jobId = await ctx.scheduler.runAfter(0, runRef, { receiptId });
		await ctx.db.patch('operationReceipts', receiptId, { outputCleanup: progress });
		return null;
	}
});
export async function repairOutputProofCleanup(ctx: MutationCtx) {
	const rows = await ctx.db
		.query('operationReceipts')
		.withIndex('by_outputCleanup_dueAt', (q) =>
			q.gte('outputCleanup.dueAt', 0).lte('outputCleanup.dueAt', Date.now())
		)
		.take(8);
	for (const row of rows)
		if (row.outputCleanup) await queueOutputProofCleanup(ctx, row._id, row.outputCleanup.through);
}
