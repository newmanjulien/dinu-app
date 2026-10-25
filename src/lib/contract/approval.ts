import type { SourceRange } from './source-model';
import type { ContractSnapshot, ContractState } from './saved';
import type { Id } from '../../convex/_generated/dataModel';

export type ReviewStatus = 'pending' | 'approved' | 'rejected';
export type ReviewDecision = Exclude<ReviewStatus, 'pending'>;
export type ReviewTag = {
	itemId: string;
	concessionId: string;
	concessionPosition: number;
	lifecycle: string;
	status: ReviewStatus;
	description: string;
	/** The main edit anchors the single tag; approval covers every concession change. */
	range: SourceRange;
	admin: boolean;
	disabled: boolean;
};
export type ReviewNavigation = { afterItemId?: string };
/** Business readiness uses saved choices and reviews, independently of document layout. */
export function savedReviews(
	items: ContractSnapshot['items'],
	state: Pick<ContractState, 'selectedConcessions' | 'reviews'>
) {
	return items.flatMap((item) => {
		const concessionId = state.selectedConcessions[item._id];
		if (!concessionId || !item.instructions?.changesNeedApproval?.trim()) return [];
		const review = state.reviews[item._id];
		return [
			{
				itemId: item._id,
				concessionId,
				concessionPosition: item.concessions.findIndex(
					(concession) => concession.id === concessionId
				),
				lifecycle: review?.concessionId === concessionId ? review.lifecycle : '',
				status: review?.concessionId === concessionId ? review.status : ('pending' as const)
			}
		];
	});
}
/** Approval metadata never contributes to document or Word content identity. */
export function selectionLifecycles(state: ContractState, required: ReadonlySet<string>) {
	if (!required.size) return {};
	return Object.fromEntries(
		Object.entries(state.selectedConcessions)
			.filter(([id]) => required.has(id))
			.map(([id, concessionId]) => {
				const review = state.reviews[id as Id<'playbookItems'>];
				if (!review || review.concessionId !== concessionId)
					throw new Error('Missing concession review metadata.');
				return [id, review.lifecycle];
			})
	);
}
export function reviewStatus(
	state: Pick<ContractState, 'reviews'>,
	itemId: string,
	concessionId: string,
	lifecycle: string
): ReviewStatus {
	const review = state.reviews[itemId as Id<'playbookItems'>];
	return review?.concessionId === concessionId && review.lifecycle === lifecycle
		? review.status
		: 'pending';
}
/** Only the current pending lifecycles determine whether an email already covers this review. */
export function approvalCoversPending(
	pending: readonly {
		itemId: string;
		concessionId: string;
		concessionPosition: number;
		lifecycle: string;
	}[],
	requested: readonly {
		itemId: string;
		concessionPosition: number;
		lifecycle?: string;
		reviewStatus?: ReviewStatus;
	}[]
) {
	if (!pending.length) return false;
	const byItem = new Map(requested.map((s) => [s.itemId, s]));
	return pending.every((current) => {
		const old = byItem.get(current.itemId);
		return (
			old &&
			old.concessionPosition === current.concessionPosition &&
			old.lifecycle === current.lifecycle &&
			old.reviewStatus === 'pending'
		);
	});
}
