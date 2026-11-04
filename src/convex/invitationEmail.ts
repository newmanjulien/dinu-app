'use node';
import { randomBytes, createHash } from 'node:crypto';
import { ConvexError, v } from 'convex/values';
import { action } from './_generated/server';
import { configuration } from './loopsEmail';
import { invitationNotification } from './emailNotifications';
import { deliverEmail } from './emailSender';
import { internal } from './_generated/api';
import { emailAddress, invitationDelivery, type InvitationDelivery } from './invitationValidators';
export const invite = action({
	args: {
		membershipId: v.id('memberships'),
		emails: v.array(v.string()),
		resend: v.optional(v.boolean())
	},
	returns: v.array(invitationDelivery),
	handler: async (ctx, args): Promise<InvitationDelivery[]> => {
		if (!args.emails.length || args.emails.length > 50)
			throw new ConvexError('Enter up to 50 valid email addresses.');
		const emails = [...new Set(args.emails.map(emailAddress))];
		let config: ReturnType<typeof configuration>;
		try {
			config = configuration('invitation');
		} catch {
			throw new ConvexError('Email is unavailable.');
		}
		const baseUrl = new URL('/invitation', config.appUrl);
		const deadline = Date.now() + 4 * 60_000;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 4 * 60_000);
		const expired = () => controller.signal.aborted || Date.now() >= deadline;
		async function deliver(email: string): Promise<InvitationDelivery> {
			try {
				const token = randomBytes(32).toString('base64url');
				const invitation = await ctx.runMutation(internal.companyInvitations.prepareDelivery, {
					membershipId: args.membershipId,
					email,
					resend: args.resend ?? false,
					inlineDeadline: deadline,
					tokenHash: createHash('sha256').update(token).digest('hex')
				});
				if (!invitation) return { email, error: null };
				const url = new URL(baseUrl);
				url.searchParams.set('invitation', token);
				const outcome = await deliverEmail(
					ctx,
					{ id: invitation.deliveryId, attempt: 1 },
					() => invitationNotification(invitation, url.href),
					{ signal: controller.signal, deadline }
				);
				return {
					email,
					error:
						outcome?.status === 'sent'
							? null
							: 'Invitation delivery could not be confirmed. You can resend it from the team page.'
				};
			} catch (error) {
				return {
					email,
					error: error instanceof ConvexError ? String(error.data) : 'Unable to send invitations.'
				};
			}
		}
		try {
			const results: InvitationDelivery[] = emails.map((email) => ({
				email,
				error: 'Invitation sending timed out. Please try again.'
			}));
			let next = 0;
			// Keep slots busy without preparing recipients before they can start sending.
			await Promise.all(
				Array.from({ length: Math.min(5, emails.length) }, async () => {
					while (!expired() && next < emails.length) {
						const index = next++;
						results[index] = await deliver(emails[index]);
					}
				})
			);
			return results;
		} finally {
			clearTimeout(timer);
			controller.abort();
		}
	}
});
