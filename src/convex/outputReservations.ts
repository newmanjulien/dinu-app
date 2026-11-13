import { makeFunctionReference } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { requireMembership } from './auth';
import { authorizePreparedOperation } from './discussionPreparation';
import { advanceOutputProof, foldOutputProofPage, initialProofCursor } from './outputProof';
import { receiptPayload, sealReceipt } from './operationReceipts';
import { queueOutputProofCleanup } from './outputProofCleanup';
import {
	outputProgress,
	outputActivateWord,
	outputActivateQuote,
	outputCheckQuote
} from './outputReferences';
const executeRef = makeFunctionReference<'mutation', { receiptId: Id<'operationReceipts'> }, null>(
	'outputReservations:execute'
);
export async function scheduleOutputPreparation(ctx: MutationCtx, row: Doc<'operationReceipts'>) {
	if (!row.outputPreparation || row.outputPreparation.phase === 'sealed') return;
	const preparation = { ...row.outputPreparation, dueAt: Date.now() };
	const job = preparation.jobId
		? await ctx.db.system.get('_scheduled_functions', preparation.jobId)
		: null;
	if (job?.state.kind !== 'pending')
		preparation.jobId = await ctx.scheduler.runAfter(0, outputProgress, { receiptId: row._id });
	await ctx.db.patch('operationReceipts', row._id, { outputPreparation: preparation });
}
export const execute = internalMutation({
	args: { receiptId: v.id('operationReceipts') },
	returns: v.null(),
	handler: async (ctx, { receiptId }) => {
		const row = await ctx.db.get('operationReceipts', receiptId);
		if (
			!row?.outputPreparation ||
			row.outputPreparation.phase === 'sealed' ||
			(row.state !== 'preparing' && row.outputPreparation.purpose !== 'release')
		)
			return null;
		const { contract } = await authorizePreparedOperation(ctx, row);
		if (row.kind === 'quote-reservation') await ctx.runMutation(outputCheckQuote, { receiptId });
		const preparation = await advanceOutputProof(ctx, row, contract);
		if (preparation.phase === 'sealed' && preparation.purpose === 'reservation')
			await ctx.runMutation(
				row.kind === 'quote-reservation' ? outputActivateQuote : outputActivateWord,
				{ receiptId }
			);
		else if (preparation.phase !== 'sealed')
			await scheduleOutputPreparation(ctx, (await ctx.db.get('operationReceipts', receiptId))!);
		return null;
	}
});
export const progress = internalMutation({
	args: { receiptId: v.id('operationReceipts') },
	returns: v.boolean(),
	handler: async (ctx, { receiptId }) => {
		const row = await ctx.db.get('operationReceipts', receiptId);
		if (!row?.outputPreparation) return true;
		try {
			await ctx.runMutation(executeRef, { receiptId });
		} catch (error) {
			const live = await ctx.db.get('operationReceipts', receiptId);
			if (!live?.outputPreparation) throw error;
			const generation = live.outputPreparation.generation;
			await ctx.db.patch('operationReceipts', receiptId, { outputPreparation: undefined });
			if (live.state === 'preparing') {
				const payload = await receiptPayload(ctx, live);
				await sealReceipt(ctx, live, payload.inputs, {
					state: 'failed',
					error:
						error instanceof ConvexError && typeof error.data === 'string'
							? error.data
							: error instanceof Error
								? error.message
								: 'This output preparation failed.'
				});
			}
			await queueOutputProofCleanup(ctx, receiptId, generation);
		}
		const live = await ctx.db.get('operationReceipts', receiptId);
		return !live?.outputPreparation || live.outputPreparation.phase === 'sealed';
	}
});
export const verify = internalMutation({
	args: { receiptId: v.id('operationReceipts') },
	returns: v.boolean(),
	handler: async (ctx, { receiptId }) => {
		const access = await requireMembership(ctx),
			row = await ctx.db.get('operationReceipts', receiptId),
			manifest = row?.reservationManifest;
		if (
			!row ||
			row.state !== 'complete' ||
			!manifest ||
			row.companyId !== access.companyId ||
			manifest.membershipId !== access.membershipId ||
			manifest.actor.profileId !== access.profile._id ||
			manifest.proof.receiptId !== row._id ||
			manifest.proof.companyId !== row.companyId ||
			manifest.proof.contractId !== row.contractId ||
			manifest.documentId !== row.documentId
		)
			throw new ConvexError('This output reservation is unavailable.');
		if (
			row.outputVerification?.generation === manifest.proof.generation &&
			row.outputVerification.complete
		)
			return true;
		const previous =
			row.outputVerification?.generation === manifest.proof.generation
				? row.outputVerification.cursor
				: initialProofCursor(manifest.proof);
		const result = await foldOutputProofPage(ctx, manifest, previous);
		await ctx.db.patch('operationReceipts', receiptId, {
			outputVerification: { generation: manifest.proof.generation, ...result }
		});
		return result.complete;
	}
});
export async function repairOutputPreparations(ctx: MutationCtx) {
	const rows = await ctx.db
		.query('operationReceipts')
		.withIndex('by_outputPreparation_dueAt', (q) =>
			q.gte('outputPreparation.dueAt', 0).lte('outputPreparation.dueAt', Date.now())
		)
		.take(8);
	for (const row of rows) await scheduleOutputPreparation(ctx, row);
}
