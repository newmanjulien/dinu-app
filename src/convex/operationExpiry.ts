import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { operationExpired, receiptPayload, sealReceipt } from './operationReceipts';
import { retireSnapshotDelivery } from './emailDisposal';
import { retireOutputPreparation } from './outputReservations';
import { cancelJob } from './emailDeliveries';

/** Expiry closes only private preparation. Dispatched/uncertain provider work keeps
 * its existing delivery/push owner, evidence and reconciliation obligations. */
export async function expireOperation(ctx: MutationCtx, row: Doc<'operationReceipts'>) {
	if (!operationExpired(row)) return false;
	if (row.outputId) {
		const output = await ctx.db.get('contractOutputs', row.outputId);
		if (
			output?.format === 'full' &&
			output.companyId === row.companyId &&
			output.contractId === row.contractId &&
			output.outputPreparation
		)
			await retireOutputPreparation(
				ctx,
				output,
				'This operation expired. Review the preserved intent against the current contract.',
				'OPERATION_EXPIRED'
			);
		// Retiring private output preparation seals the replay receipt too.
		if (output?.state === 'preparing') return true;
	}
	if (row.state !== 'preparing') return true;
	if (row.emailPreparation) {
		const delivery = await ctx.db.get('emailDeliveries', row.emailPreparation.deliveryId);
		if (
			delivery &&
			'snapshot' in delivery &&
			delivery.snapshot.state === 'staging' &&
			delivery.snapshot.receiptId === row._id
		)
			await retireSnapshotDelivery(ctx, delivery);
		await ctx.db.patch('operationReceipts', row._id, { emailPreparation: undefined });
	}
	await cancelJob(ctx, row.preparation?.native?.jobId);
	await cancelJob(ctx, row.preparation?.passageJobId);
	await sealReceipt(ctx, row, (await receiptPayload(ctx, row)).inputs, {
		state: 'failed',
		errorCode: 'OPERATION_EXPIRED',
		error: 'This operation expired. Review the preserved intent against the current contract.'
	});
	return true;
}
