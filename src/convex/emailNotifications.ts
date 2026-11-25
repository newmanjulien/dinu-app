import type { EmailEvent } from './emailValidators';

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
	event: Exclude<EmailEvent, { kind: 'invitation' }>
): EmailNotification {
	const path = `${appUrl}/contracts/${event.contractId}`;
	const url = event.kind === 'approval' ? `${path}?review=1` : path;
	if (event.kind === 'decision') {
		return {
			kind: 'decision',
			data: {
				companyName: event.title,
				url,
				approvedCount: event.approvedCount,
				rejectedCount: event.rejectedCount
			}
		};
	}
	return {
		kind: 'approval',
		data: {
			companyName: event.title,
			url,
			pendingCount: event.pendingCount,
			reviewedCount: event.reviewedCount,
			notRequiredCount: event.notRequiredCount
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
