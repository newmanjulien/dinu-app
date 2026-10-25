'use node';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { emailAttempt } from './emailValidators';
import { deliverEmail, loadDescriptions } from './smtpEmail';

export const send = internalAction({
	args: emailAttempt.fields,
	returns: v.null(),
	handler: async (ctx, args): Promise<null> => {
		await deliverEmail(ctx, args, async (config, delivery, selections) => {
			const event = delivery.event;
			if (event.kind === 'invitation')
				throw new Error('Invitations are sent by their inline worker.');
			const descriptions = await loadDescriptions(selections, (selections) =>
				ctx.runQuery(internal.emailSnapshots.descriptions, {
					companyId: delivery.companyId,
					templateVersionId: event.templateVersionId,
					selections
				})
			);
			const groups = new Map<string, string[]>();
			const multipleReviewers =
				new Set(selections.flatMap((s) => (s.reviewerId ? [s.reviewerId] : []))).size > 1;
			for (const [index, selection] of selections.entries()) {
				const description = descriptions[index];
				const group =
					event.kind === 'decision'
						? selection.reviewStatus === 'approved'
							? 'Approved'
							: 'Not approved'
						: !description.requiresApproval
							? 'Concessions not requiring approval'
							: selection.reviewStatus === 'pending'
								? 'Concessions waiting for review'
								: 'Previously reviewed concessions';
				const suffix =
					event.kind === 'decision'
						? multipleReviewers && selection.reviewerName
							? ` (${selection.reviewerName})`
							: ''
						: description.requiresApproval && selection.reviewStatus !== 'pending'
							? ` (${selection.reviewStatus === 'approved' ? 'Approved' : 'Not approved'})`
							: '';
				const entries = groups.get(group) ?? [];
				entries.push(`- ${description.description}${suffix}`);
				groups.set(group, entries);
			}
			const order =
				event.kind === 'decision'
					? ['Approved', 'Not approved']
					: [
							'Concessions waiting for review',
							'Previously reviewed concessions',
							'Concessions not requiring approval'
						];
			const sections = order
				.filter((name) => groups.has(name))
				.map((name) => `${name}:\n${groups.get(name)!.join('\n')}`)
				.join('\n\n');
			const link = `${config.appUrl}/contracts/${event.contractId}`;
			return event.kind === 'decision'
				? {
						subject: `Concessions reviewed — ${event.companyName}'s contract`,
						text: `All concessions requiring approval for ${event.companyName}'s contract have been reviewed.\n\n${sections}\n\nOpen the contract: ${link}`
					}
				: {
						subject: `Approval requested — ${event.companyName}'s contract`,
						text: `Approval was requested for contract that's being prepared for ${event.companyName}.\n\nOpen the contract to approve: ${link}?review=1\n\n${sections}`
					};
		});
		return null;
	}
});
