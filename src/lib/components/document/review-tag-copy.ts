import { availableReviewDecisions, type ReviewTag } from '$lib/contract/approval';

export function reviewTagExplanation(tag: ReviewTag, ready: boolean): string {
	const meaning =
		tag.status === 'approved'
			? 'This concession is applied to the current contract.'
			: tag.status === 'rejected'
				? 'This concession was declined.'
				: 'This concession needs admin approval.';
	if (!tag.admin)
		return tag.status === 'pending'
			? `${meaning} Choose “Submit for approval” if you haven’t already.`
			: meaning;
	if (!ready || tag.disabled) return `${meaning} Review is temporarily unavailable.`;
	const decisions = availableReviewDecisions(tag.status);
	if (decisions.length === 2) return `${meaning} Click to approve or decline it.`;
	if (decisions[0] === 'decline') return `${meaning} Click to decline it.`;
	return `${meaning} Click to approve it.`;
}
