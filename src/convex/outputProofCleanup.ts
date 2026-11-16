import { internal } from './_generated/api';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { activeJob, cancelJob } from './emailDeliveries';
import { cleanupBudget } from './cleanup';
export async function queueOutputProofCleanup(
	ctx: MutationCtx,
	outputId: Id<'contractOutputs'>,
	through: number
) {
	const row = await ctx.db.get('contractOutputs', outputId);
	if (!row || row.format !== 'full' || through < 0) return;
	const cleanup = row.outputCleanup
		? { ...row.outputCleanup, through: Math.max(row.outputCleanup.through, through) }
		: {
				generation: 0,
				through,
				dueAt: Date.now(),
				jobId: undefined as Id<'_scheduled_functions'> | undefined
			};
	if (!(await activeJob(ctx, cleanup.jobId)))
		cleanup.jobId = await ctx.scheduler.runAfter(0, internal.outputProofCleanup.run, { outputId });
	await ctx.db.patch('contractOutputs', outputId, { outputCleanup: cleanup });
}
export const run = internalMutation({
	args: { outputId: v.id('contractOutputs') },
	returns: v.null(),
	handler: async (ctx, { outputId }) => {
		const row = await ctx.db.get('contractOutputs', outputId);
		if (row?.format !== 'full' || !row.outputCleanup) return null;
		const progress = { ...row.outputCleanup };
		if (
			row.reservationManifest?.proof.generation === progress.generation ||
			row.outputPreparation?.generation === progress.generation
		)
			progress.generation++;
		if (progress.generation > progress.through) {
			await ctx.db.patch('contractOutputs', outputId, { outputCleanup: undefined });
			return null;
		}
		const chunks = await ctx.db
			.query('contractOutputChunks')
			.withIndex('by_outputId_and_section_and_generation_and_order', (q) =>
				q
					.eq('outputId', outputId)
					.eq('section', 'output-proof')
					.gte('generation', progress.generation)
					.lte('generation', progress.through)
			)
			.take(8);
		for (const chunk of chunks) {
			if (
				chunk.companyId !== row.companyId ||
				chunk.contractId !== row.contractId ||
				chunk.outputId !== row._id
			)
				throw new Error('Output garbage owner changed.');
			if (
				chunk.generation === row.reservationManifest?.proof.generation ||
				chunk.generation === row.outputPreparation?.generation
			) {
				progress.generation = chunk.generation + 1;
				break;
			}
			await ctx.db.delete('contractOutputChunks', chunk._id);
			progress.generation = chunk.generation;
		}
		if (!chunks.length) {
			await ctx.db.patch('contractOutputs', outputId, { outputCleanup: undefined });
			return null;
		}
		progress.dueAt = Date.now();
		progress.jobId = await ctx.scheduler.runAfter(0, internal.outputProofCleanup.run, { outputId });
		await ctx.db.patch('contractOutputs', outputId, { outputCleanup: progress });
		return null;
	}
});
export async function repairOutputProofCleanup(ctx: MutationCtx) {
	const rows = await ctx.db
		.query('contractOutputs')
		.withIndex('by_outputCleanup_dueAt', (q) =>
			q.gte('outputCleanup.dueAt', 0).lte('outputCleanup.dueAt', Date.now())
		)
		.take(8);
	for (const row of rows)
		if (row.format === 'full' && row.outputCleanup)
			await queueOutputProofCleanup(ctx, row._id, row.outputCleanup.through);
}

/** Company erasure is a separate owner boundary and cancels exact output jobs before sections. */
export async function cleanupCompanyOutputs(
	ctx: MutationCtx,
	companyId: Id<'company'>,
	{ drain } = cleanupBudget(ctx)
) {
	// Durable outputs own their own jobs and proof sections independently of replay receipts.
	if (
		!(await drain(
			'contractOutputs',
			ctx.db
				.query('contractOutputs')
				.withIndex('by_companyId', (q) => q.eq('companyId', companyId)),
			{
				beforeDelete: async (row) => {
					if (row.format !== 'full') return;
					await cancelJob(ctx, row.outputPreparation?.jobId);
					await cancelJob(ctx, row.outputCleanup?.jobId);
				}
			}
		))
	)
		return false;
	if (
		!(await drain(
			'contractOutputChunks',
			ctx.db
				.query('contractOutputChunks')
				.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
		))
	)
		return false;

	return true;
}
