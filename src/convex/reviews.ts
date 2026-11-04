import { ConvexError, type Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import type { concessionReviews, selections, storedDecision } from './contractValidators';
import type { historicalItem } from './playbookValidators';
import { MAX_APPLICATION_LIFECYCLE_LENGTH } from '../lib/contract/selection-limits';

/** Each required choice has one current application, independent of its audit history. */
export function reviewsForSelections(
	items: Infer<typeof historicalItem>[],
	selected: Infer<typeof selections>,
	lifecycles: Record<Id<'playbookItems'>, string>,
	previousReviews: Infer<typeof concessionReviews>,
	reviewerRole: Doc<'profiles'>['role']
) {
	const reviews: Infer<typeof concessionReviews> = {};
	const autoApprovedItemIds: Id<'playbookItems'>[] = [];
	for (const item of items) {
		if (!item.instructions?.changesNeedApproval?.trim()) continue;
		const concessionId = selected[item._id];
		const previous = previousReviews[item._id];
		const lifecycle = lifecycles[item._id];
		if (!lifecycle?.trim() || lifecycle.length > MAX_APPLICATION_LIFECYCLE_LENGTH)
			throw new ConvexError('Invalid concession application.');
		const unchanged = previous?.concessionId === concessionId && previous.lifecycle === lifecycle;
		reviews[item._id] = unchanged
			? previous
			: { concessionId, lifecycle, status: reviewerRole === 'admin' ? 'approved' : 'pending' };
		if (!unchanged && reviewerRole === 'admin') autoApprovedItemIds.push(item._id);
	}
	return { reviews, autoApprovedItemIds };
}

/** Both explicit decisions and admin application saves write complete immutable receipts. */
export function recordDecision(
	ctx: MutationCtx,
	contract: Pick<Doc<'savedContracts'>, '_id' | 'companyId'>,
	reviewer: Pick<Doc<'profiles'>, '_id' | 'name' | 'email'>,
	decision: Omit<
		Infer<typeof storedDecision>,
		'companyId' | 'contractId' | 'adminId' | 'adminName' | 'adminEmail'
	>
) {
	return ctx.db.insert('concessionDecisions', {
		...decision,
		companyId: contract.companyId,
		contractId: contract._id,
		adminId: reviewer._id,
		adminName: reviewer.name,
		adminEmail: reviewer.email
	});
}

export function completedReview(
	contract: Pick<Doc<'savedContracts'>, 'reviews' | 'selectedConcessions'>
) {
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

/** Review supplies current business context; delivery owns when that context is frozen. */
export function decisionSelections(contract: Pick<Doc<'savedContracts'>, 'reviews'>) {
	return Object.entries(contract.reviews)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([id, review]) => ({
			itemId: id as Id<'playbookItems'>,
			concessionId: review.concessionId,
			lifecycle: review.lifecycle,
			reviewStatus: review.status
		}));
}
