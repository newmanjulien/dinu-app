import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { createDelivery } from './emailDeliveries';
import { completedReview } from './reviews';

/** Only an explicit changed decision calls this, atomically with its new generation. */
export async function queueCompletedReview(
	ctx: MutationCtx,
	contract: Doc<'savedContracts'>,
	reviewerId: Id<'profiles'>
) {
	if (!completedReview(contract)) return false;
	await createDelivery(ctx, {
		companyId: contract.companyId,
		event: {
			kind: 'decision',
			contractId: contract._id,
			reviewGeneration: contract.reviewGeneration,
			reviewerId,
			companyName: contract.companyName,
			templateVersionId: contract.templateVersionId
		}
	});
	return true;
}
