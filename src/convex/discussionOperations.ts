import { ConvexError, v } from 'convex/values';
import { internalMutation } from './_generated/server';
import type { PlaybookCommand } from '../lib/contract/changes';
import { saveCommands } from './contractSaving';
import { receiptPayload, sealReceipt } from './operationReceipts';
import { authorizePreparedOperation, nativeOperationKey } from './discussionPreparation';
import { ensureDiscussionMaintenance } from './discussionMaintenance';
import { operationExecute } from './discussionOperationReferences';
import { advanceNativeValidation } from './nativePlanPreparation';
import { adoptNativeSave, advanceNativeProof } from './nativeConstruction';
import { advanceAuthority } from './nativeAuthority';
import { DiscussionPreparationRequired } from './discussionMaps';
import { advanceEmailOperation } from './nativeEmail';
import { retireSnapshotDelivery } from './emailDisposal';
import { advanceDiscussionOperation } from './discussionExecution';

/** Only this internal execution path may bypass the ordinary preparing replay fence.
 * Each native executor must reconstruct the exact original input, not create a new operation. */
export const execute = internalMutation({
	args: { receiptId: v.id('operationReceipts') },
	returns: v.null(),
	handler: async (ctx, { receiptId }) => {
		const stored = await ctx.db.get('operationReceipts', receiptId);
		if (!stored || stored.state !== 'preparing') return null;
		const { contract, access } = await authorizePreparedOperation(ctx, stored);
		const row = await receiptPayload(ctx, stored);
		if (row.kind === 'playbook-save') {
			if (!access || nativeOperationKey(access, row.kind, row.operationId!) !== row.key)
				throw new Error('Pending save actor/key is invalid.');
			const input: unknown = JSON.parse(row.inputs);
			if (
				!Array.isArray(input) ||
				input.length !== 2 ||
				input[0] !== contract.root._id ||
				!input[1] ||
				typeof input[1] !== 'object'
			)
				throw new Error('Pending save input is invalid.');
			// These bytes came from validated native args at initial admission.
			const args = input[1] as { commands: PlaybookCommand[]; operationId: string };
			if (args.operationId !== row.operationId || !Array.isArray(args.commands))
				throw new Error('Pending save operation identity changed.');
			if (row.preparation?.native) {
				const validation = await advanceNativeValidation(ctx, row, contract);
				if (validation === 'progress') return null;
				if (validation === 'sealed') {
					if (!row.preparation.proofComplete || !row.preparation.supportComplete) {
						await advanceNativeProof(ctx, row, contract);
						return null;
					}
					try {
						if (!(await adoptNativeSave(ctx, row))) await advanceNativeProof(ctx, row, contract);
					} catch (error) {
						if (!(error instanceof DiscussionPreparationRequired)) throw error;
					}
					return null;
				}
				// Changed source/semantics re-enter the original touched-head merge path.
				// A validated or sealed oversized plan never falls back to reconstruction.
			}
			const result = await saveCommands(ctx, access, contract, args, undefined, row);
			const live = await ctx.db.get('operationReceipts', receiptId);
			if (result.status !== 'preparing' && live?.state === 'preparing') {
				await sealReceipt(ctx, live, row.inputs, {
					state: 'complete',
					result: JSON.stringify(result)
				});
			}
		} else if (row.kind === 'change-decision' || row.kind === 'proposal-support') {
			if (!access || nativeOperationKey(access, row.kind, row.operationId!) !== row.key)
				throw new Error('Pending authority actor/key is invalid.');
			try {
				await advanceAuthority(ctx, row, contract);
			} catch (error) {
				if (!(error instanceof DiscussionPreparationRequired)) throw error;
			}
		} else if (row.kind === 'approval-request' || row.kind === 'review-completion') {
			try {
				await advanceEmailOperation(ctx, row);
			} catch (error) {
				if (!(error instanceof DiscussionPreparationRequired)) throw error;
			}
		} else if (row.kind === 'discussion-write' || row.kind === 'discussion-mark-seen') {
			try {
				await advanceDiscussionOperation(ctx, row);
			} catch (error) {
				if (!(error instanceof DiscussionPreparationRequired)) throw error;
			}
		} else throw new Error('This native operation has no preparation executor.');
		return null;
	}
});

export const resume = internalMutation({
	args: { receiptId: v.id('operationReceipts') },
	returns: v.null(),
	handler: async (ctx, { receiptId }) => {
		const original = await ctx.db.get('operationReceipts', receiptId);
		if (!original || original.state !== 'preparing') return null;
		try {
			await ctx.runMutation(operationExecute, { receiptId });
		} catch (error) {
			// A nested transaction rolls back every attempted business write before failure is sealed.
			const live = await ctx.db.get('operationReceipts', receiptId);
			if (!live || live.state !== 'preparing') throw error;
			if (live.emailPreparation) {
				const delivery = await ctx.db.get('emailDeliveries', live.emailPreparation.deliveryId);
				if (
					delivery &&
					'snapshot' in delivery &&
					delivery.snapshot.state === 'staging' &&
					delivery.snapshot.receiptId === live._id
				)
					await retireSnapshotDelivery(ctx, delivery);
			}
			const message =
				error instanceof ConvexError && typeof error.data === 'string'
					? error.data
					: error instanceof Error
						? error.message
						: 'This operation could not complete.';
			console.error('Prepared contract operation failed', receiptId, error);
			await sealReceipt(ctx, live, (await receiptPayload(ctx, live)).inputs, {
				state: 'failed',
				error: message
			});
			if (live.preparation?.map && live.contractId)
				await ensureDiscussionMaintenance(ctx, live.contractId);
		}
		return null;
	}
});
