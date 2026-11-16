import type { FullOutput } from './outputLifecycle';
import { requireLiveDocumentOwner } from './contractDocumentLifetime';
import { internal } from './_generated/api';
import { ConvexError, v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx } from './_generated/server';
import { requireMembership } from './auth';
import { authorizePreparedOperation } from './discussionPreparation';
import {
	advanceOutputProof,
	foldOutputProofPage,
	initialProofCursor,
	outputReservation
} from './outputProof';
import { receiptPayload, sealReceipt, admitOperation, operationExpired } from './operationReceipts';
import { queueOutputProofCleanup } from './outputProofCleanup';
import { cancelJob } from './emailDeliveries';
import type { OutputPreparation } from './outputValidators';
import { canonicalJson } from '../lib/document/canonical-json';
/** Only private reservation work needs a live replay receipt. Release and history do not. */
export async function outputReceipt(ctx: QueryCtx, row: FullOutput) {
	const receipt = row.receiptId ? await ctx.db.get('operationReceipts', row.receiptId) : null;
	if (
		!receipt ||
		receipt.state !== 'preparing' ||
		receipt.outputId !== row._id ||
		receipt.companyId !== row.companyId ||
		receipt.contractId !== row.contractId ||
		receipt.key !== row.key ||
		receipt.operationId !== row.operationId ||
		receipt.executionUntil !== row.executionUntil ||
		receipt.kind !== row.kind ||
		canonicalJson(receipt.actor) !== canonicalJson(row.actor)
	)
		throw new Error('Private output reservation receipt changed.');
	return receipt;
}
export async function createOutput(
	ctx: MutationCtx,
	receiptId: Id<'operationReceipts'>,
	preparation: OutputPreparation,
	kind: FullOutput['kind']
) {
	const receipt = await ctx.db.get('operationReceipts', receiptId);
	if (
		!receipt ||
		receipt.state !== 'preparing' ||
		receipt.outputId ||
		!receipt.actor ||
		!receipt.operationId ||
		receipt.kind !== kind ||
		receipt.contractId !== preparation.base.contractId ||
		receipt.companyId !== preparation.base.companyId ||
		receipt.actor.kind !== 'seller' ||
		receipt.actor.profileId !== preparation.base.actor.profileId ||
		receipt.actor.membershipId !== preparation.base.membershipId
	)
		throw new Error('Invalid new output reservation ownership.');
	await requireLiveDocumentOwner(ctx, preparation.base);
	const outputId = await ctx.db.insert('contractOutputs', {
		format: 'full',
		retentionDueAt: receipt.executionUntil,
		companyId: receipt.companyId,
		contractId: preparation.base.contractId,
		documentId: preparation.base.documentId,
		kind,
		state: 'preparing',
		receiptId,
		key: receipt.key,
		operationId: receipt.operationId,
		actor: receipt.actor,
		executionUntil: receipt.executionUntil,
		outputGeneration: preparation.generation,
		outputPreparation: preparation
	});
	await ctx.db.patch('operationReceipts', receiptId, { outputId });
	const output = await ctx.db.get('contractOutputs', outputId);
	if (output?.format !== 'full') throw new Error('Invalid new output owner.');
	return output;
}
/** Retire private proof without changing any dispatched/uncertain external outcome. */
export async function retireOutputPreparation(
	ctx: MutationCtx,
	row: FullOutput,
	error: string,
	errorCode?: 'OPERATION_EXPIRED'
) {
	const preparation = row.outputPreparation;
	await cancelJob(ctx, preparation?.jobId);
	if (row.state === 'preparing') {
		const receipt = await outputReceipt(ctx, row);
		await sealReceipt(ctx, receipt, (await receiptPayload(ctx, receipt)).inputs, {
			state: 'failed',
			error,
			...(errorCode ? { errorCode } : {})
		});
	}
	await ctx.db.patch('contractOutputs', row._id, {
		outputPreparation: undefined,
		...(row.state === 'preparing' ? { state: 'failed' as const, error, receiptId: undefined } : {})
	});
	if (preparation) await queueOutputProofCleanup(ctx, row._id, preparation.generation);
}
export async function scheduleOutputPreparation(ctx: MutationCtx, row: FullOutput) {
	if (!row.outputPreparation || row.outputPreparation.phase === 'sealed') return;
	const preparation = { ...row.outputPreparation, dueAt: Date.now() };
	const job = preparation.jobId
		? await ctx.db.system.get('_scheduled_functions', preparation.jobId)
		: null;
	if (job?.state.kind !== 'pending')
		preparation.jobId = await ctx.scheduler.runAfter(0, internal.outputReservations.progress, { outputId: row._id });
	await ctx.db.patch('contractOutputs', row._id, { outputPreparation: preparation });
}
export const execute = internalMutation({
	args: { outputId: v.id('contractOutputs') },
	returns: v.null(),
	handler: async (ctx, { outputId }) => {
		const row = await ctx.db.get('contractOutputs', outputId);
		if (
			row?.format !== 'full' ||
			!row.outputPreparation ||
			row.outputPreparation.phase === 'sealed' ||
			(row.state !== 'preparing' && row.outputPreparation.purpose !== 'release')
		)
			return null;
		if (operationExpired(row)) {
			await retireOutputPreparation(
				ctx,
				row,
				'This operation expired. Review the preserved intent against the current contract.',
				'OPERATION_EXPIRED'
			);
			return null;
		}
		const { contract } = await authorizePreparedOperation(ctx, row);
		if (row.kind === 'quote-reservation') await ctx.runMutation(internal.hubspotQuotes.checkPrepared, { outputId });
		const preparation = await advanceOutputProof(ctx, row, contract);
		if (preparation.phase === 'sealed' && preparation.purpose === 'reservation')
			await ctx.runMutation(
				row.kind === 'quote-reservation' ? internal.hubspotQuotes.activatePrepared : internal.contractExports.activatePrepared,
				{ outputId }
			);
		else if (preparation.phase !== 'sealed')
			await scheduleOutputPreparation(ctx, { ...row, outputPreparation: preparation });
		return null;
	}
});
export const progress = internalMutation({
	args: { outputId: v.id('contractOutputs') },
	returns: v.boolean(),
	handler: async (ctx, { outputId }) => {
		const row = await ctx.db.get('contractOutputs', outputId);
		if (row?.format !== 'full' || !row.outputPreparation) return true;
		try {
			await ctx.runMutation(internal.outputReservations.execute, { outputId });
		} catch (error) {
			const live = await ctx.db.get('contractOutputs', outputId);
			if (live?.format !== 'full' || !live.outputPreparation) throw error;
			await retireOutputPreparation(
				ctx,
				live,
				error instanceof ConvexError && typeof error.data === 'string'
					? error.data
					: error instanceof Error
						? error.message
						: 'This output preparation failed.'
			);
		}
		const live = await ctx.db.get('contractOutputs', outputId);
		return (
			live?.format !== 'full' ||
			!live.outputPreparation ||
			live.outputPreparation.phase === 'sealed'
		);
	}
});
export const verify = internalMutation({
	args: { outputId: v.id('contractOutputs') },
	returns: v.boolean(),
	handler: async (ctx, { outputId }) => {
		const access = await requireMembership(ctx),
			row = await ctx.db.get('contractOutputs', outputId),
			manifest = row?.format === 'full' ? row.reservationManifest : undefined;
		if (
			!row ||
			row.format !== 'full' ||
			row.state !== 'complete' ||
			!manifest ||
			row.companyId !== access.companyId ||
			manifest.membershipId !== access.membershipId ||
			manifest.actor.profileId !== access.profile._id ||
			manifest.proof.outputId !== row._id ||
			manifest.proof.companyId !== row.companyId ||
			manifest.proof.contractId !== row.contractId ||
			manifest.documentId !== row.documentId
		)
			throw new ConvexError('This output reservation is unavailable.');
		await outputReservation(ctx, { ...row, outputId: row._id });
		admitOperation(row.operationId);
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
		await ctx.db.patch('contractOutputs', outputId, {
			outputVerification: { generation: manifest.proof.generation, ...result }
		});
		return result.complete;
	}
});
export async function repairOutputPreparations(ctx: MutationCtx) {
	const rows = await ctx.db
		.query('contractOutputs')
		.withIndex('by_outputPreparation_dueAt', (q) =>
			q.gte('outputPreparation.dueAt', 0).lte('outputPreparation.dueAt', Date.now())
		)
		.take(8);
	for (const row of rows) if (row.format === 'full') await scheduleOutputPreparation(ctx, row);
}
