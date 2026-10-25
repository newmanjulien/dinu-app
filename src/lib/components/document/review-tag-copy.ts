import type { ReviewStatus, ReviewTag } from '$lib/contract/approval';

type ReviewTagCopy = { meaning: string; nextStep?: string };

const reviewTagCopy: Record<'admin' | 'rep', Record<ReviewStatus, ReviewTagCopy>> = {
	admin: {
		pending: {
			meaning: 'This concession needs your review.',
			nextStep: 'Click to approve or decline it.'
		},
		approved: {
			meaning: 'This concession is approved.',
			nextStep: 'Click to change the decision.'
		},
		rejected: {
			meaning: 'This concession was declined.',
			nextStep: 'Click to change the decision.'
		}
	},
	rep: {
		pending: {
			meaning: 'This concession needs admin approval.',
			nextStep: 'Choose “Ask for approval” if you haven’t already.'
		},
		approved: {
			meaning: 'This concession is approved for use in this contract.'
		},
		rejected: {
			meaning: 'This concession was declined.',
			nextStep: 'Remove it or choose another concession before downloading.'
		}
	}
};

export function reviewTagExplanation(tag: ReviewTag, ready: boolean): string {
	const copy = reviewTagCopy[tag.admin ? 'admin' : 'rep'][tag.status];
	const nextStep =
		tag.admin && (tag.disabled || !ready) ? 'Review is temporarily unavailable.' : copy.nextStep;
	return nextStep ? `${copy.meaning} ${nextStep}` : copy.meaning;
}
