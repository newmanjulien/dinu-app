import type { ReviewTag } from '$lib/contract/approval';

export function reviewTagExplanation(tag: ReviewTag, ready: boolean): string {
	const subject = tag.kind === 'buyer-link' ? 'buyer proposal' : 'Playbook change';
	const meaning =
		tag.status === 'approved'
			? `This ${subject} is applied to the current contract.`
			: tag.status === 'rejected'
				? `This ${subject} was declined.`
				: `This ${subject} needs admin approval.`;
	if (!tag.admin)
		return tag.status === 'pending'
			? `${meaning} Choose “Submit for approval” if you haven’t already.`
			: meaning;
	if (!ready || tag.disabled) return `${meaning} Review is temporarily unavailable.`;
	if (tag.status === 'approved' && tag.kind === 'playbook')
		return `${meaning} Use the Playbook to remove or switch this option.`;
	const permissions = tag.status === 'approved' ? [tag.undo] : [tag.approve, tag.decline];
	if (permissions.some((permission) => permission.allowed === null))
		return `${meaning} Checking this action…`;
	const allowed = permissions.some((permission) => permission.allowed);
	if (!allowed)
		return `${meaning} ${permissions.find((permission) => permission.reason)?.reason ?? 'Use the Playbook to remove or switch an applied option.'}`;
	return `${meaning} ${tag.status === 'approved' ? 'Click to undo this approved proposal.' : 'Click to approve or decline it.'}`;
}
