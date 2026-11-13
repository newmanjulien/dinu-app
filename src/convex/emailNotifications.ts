import { buyerPath } from '../lib/buyer/urls';
import type { EmailEvent, EmailCounts } from './emailValidators';

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
	counts: EmailCounts
): EmailNotification {
	const path =
		event.context === 'buyer-link' && event.buyerToken
			? `${appUrl}${buyerPath(event.buyerToken)}/contract`
			: `${appUrl}/contracts/${event.contractId}`;
	const params = new URLSearchParams();
	if (event.kind === 'approval' || event.context === 'buyer-link') params.set('review', '1');
	const url = `${path}${params.size ? `?${params}` : ''}`;
	if (event.kind === 'decision') {
		const { approvedCount, rejectedCount } = counts;
		return {
			kind: 'decision',
			data: {
				companyName: event.title,
				url,
				approvedCount,
				rejectedCount
			}
		};
	}
	const { pendingCount, reviewedCount, notRequiredCount } = counts;
	return {
		kind: 'approval',
		data: {
			companyName: event.title,
			url,
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
