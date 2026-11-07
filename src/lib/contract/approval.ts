import type { Id } from '../../convex/_generated/dataModel';
import type { ContractState, TemplateContent } from './saved';
import type { SourceTarget } from './source-model';

export type ReviewStatus = 'pending' | 'approved' | 'rejected';
export type ReviewDecision = Exclude<ReviewStatus, 'pending'>;
export type ReviewTag = {
	itemId: string;
	concessionId: string;
	concessionPosition: number;
	applicationId: string;
	status: ReviewStatus;
	description: string;
	/** The main edit anchors the single tag; approval covers every concession change. */
	target: SourceTarget;
	admin: boolean;
	disabled: boolean;
};
export type ReviewNavigation = { afterItemId?: string };
/** Selected approval changes can be identified without a prepared document. */
export function selectedReviewApplications(
	items: TemplateContent['items'],
	choices: Readonly<Record<string, string>>
) {
	return items.flatMap((item) => {
		const selected = choices[item._id];
		if (!selected || item.approvalPolicy.kind !== 'required') return [];
		const concessionPosition = item.concessions.findIndex((c) => c.id === selected);
		const concession = item.concessions[concessionPosition];
		if (!concession) return [];
		const range = concession.changes[0]?.target ?? item.trigger.target;
		if (!range) return [];
		return [{ item, concession, concessionPosition, target: range }];
	});
}
/** Business readiness uses saved choices and reviews, independently of document layout. */
export function savedReviews(
	items: TemplateContent['items'],
	state: Pick<ContractState, 'applications'>
) {
	return items.flatMap((item) => {
		const concessionId = state.applications[item._id]?.concessionId;
		if (!concessionId || item.approvalPolicy.kind !== 'required') return [];
		const review = state.applications[item._id]?.approval;
		return [
			{
				itemId: item._id,
				concessionId,
				concessionPosition: item.concessions.findIndex(
					(concession) => concession.id === concessionId
				),
				applicationId: review ? review.applicationId : '',
				status: review ? review.status : ('pending' as const)
			}
		];
	});
}
export function reviewStatus(
	state: Pick<ContractState, 'applications'>,
	itemId: string,
	concessionId: string,
	applicationId: string
): ReviewStatus {
	const review = state.applications[itemId as Id<'playbookItems'>]?.approval;
	return state.applications[itemId as Id<'playbookItems'>]?.concessionId === concessionId &&
		review?.applicationId === applicationId
		? review.status
		: 'pending';
}
/** Only the current pending applicationIds determine whether an email already covers this review. */
export function approvalCoversPending(
	pending: readonly {
		itemId: string;
		concessionId: string;
		concessionPosition: number;
		applicationId: string;
	}[],
	requested: readonly {
		itemId: string;
		concessionPosition: number;
		approval?: { applicationId: string; status: ReviewStatus };
	}[]
) {
	if (!pending.length) return false;
	const byItem = new Map(requested.map((s) => [s.itemId, s]));
	return pending.every((current) => {
		const old = byItem.get(current.itemId);
		return (
			old &&
			old.concessionPosition === current.concessionPosition &&
			old.approval?.applicationId === current.applicationId &&
			old.approval?.status === 'pending'
		);
	});
}
