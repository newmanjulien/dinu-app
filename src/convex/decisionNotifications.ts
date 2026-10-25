import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { createDelivery } from './emailDeliveries';
import { attributionsFor, applicationKey } from './reviewAttributions';
import type { EmailSelection } from './emailValidators';

export function completedReview(contract: Doc<'savedContracts'>) {
	const reviews = Object.entries(contract.reviews);
	return (
		reviews.length > 0 &&
		reviews.every(
			([id, review]) =>
				contract.selectedConcessions[id as Id<'playbookItems'>] === review.concessionId &&
				review.status !== 'pending'
		)
	);
}
/** Only an explicit changed decision calls this, atomically with its new generation. */
export async function queueCompletedReview(ctx: MutationCtx, contract: Doc<'savedContracts'>) {
	if (!completedReview(contract)) return;
	await createDelivery(ctx, {
		companyId: contract.companyId,
		contractId: contract._id,
		event: {
			kind: 'decision',
			contractId: contract._id,
			reviewGeneration: contract.reviewGeneration ?? 0,
			companyName: contract.companyName,
			templateVersionId: contract.templateVersionId
		}
	});
}
export async function decisionSelections(
	ctx: QueryCtx,
	contract: Doc<'savedContracts'>
): Promise<EmailSelection[]> {
	const { entries } = await attributionsFor(ctx, contract._id);
	const reviewers = new Map(entries.map((entry) => [entry.itemId, entry]));
	return Object.entries(contract.reviews)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([id, review]) => {
			const itemId = id as Id<'playbookItems'>;
			const reviewer = reviewers.get(itemId);
			const attributed =
				reviewer?.applicationKey === applicationKey(review.concessionId, review.lifecycle);
			return {
				itemId,
				concessionId: review.concessionId,
				lifecycle: review.lifecycle,
				reviewStatus: review.status,
				...(attributed
					? { reviewerId: reviewer.reviewerId, reviewerName: reviewer.reviewerName }
					: {})
			};
		});
}
