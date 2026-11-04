import type { EmailEvent, EmailSelection } from './emailValidators';

/** Templates own copy and structure; the app supplies only event data. */
export type EmailNotification =
	| {
			kind: 'invitation';
			data: { companyName: string; inviterName: string; email: string; url: string };
	  }
	| {
			kind: 'approval';
			data: {
				companyName: string;
				url: string;
				pendingCount: number;
				reviewedCount: number;
				notRequiredCount: number;
			};
	  }
	| {
			kind: 'decision';
			data: { companyName: string; url: string; approvedCount: number; rejectedCount: number };
	  };

export function contractNotification(
	appUrl: string,
	event: Exclude<EmailEvent, { kind: 'invitation' }>,
	selections: EmailSelection[]
): EmailNotification {
	const url = `${appUrl}/contracts/${event.contractId}`;
	if (event.kind === 'decision') {
		let approvedCount = 0;
		let rejectedCount = 0;
		for (const selection of selections) {
			if (selection.reviewStatus === 'approved') approvedCount++;
			else if (selection.reviewStatus === 'rejected') rejectedCount++;
			else throw new Error('Completed review snapshot contains an unresolved concession.');
		}
		return {
			kind: 'decision',
			data: { companyName: event.companyName, url, approvedCount, rejectedCount }
		};
	}
	let pendingCount = 0;
	let reviewedCount = 0;
	let notRequiredCount = 0;
	for (const selection of selections) {
		if (selection.reviewStatus === undefined) notRequiredCount++;
		else if (selection.reviewStatus === 'pending') pendingCount++;
		else reviewedCount++;
	}
	return {
		kind: 'approval',
		data: {
			companyName: event.companyName,
			url: `${url}?review=1`,
			pendingCount,
			reviewedCount,
			notRequiredCount
		}
	};
}

export function invitationNotification(
	invitation: { companyName: string; inviterName: string; email: string },
	url: string
): EmailNotification {
	return {
		kind: 'invitation',
		data: {
			companyName: invitation.companyName,
			inviterName: invitation.inviterName,
			email: invitation.email,
			url
		}
	};
}
