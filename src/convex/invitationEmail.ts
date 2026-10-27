'use node';
import { randomBytes, createHash } from 'node:crypto';
import { connect, type TLSSocket } from 'node:tls';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { ConvexError, v } from 'convex/values';
import { action } from './_generated/server';
import { configuration, transportOptions, deliverEmail } from './smtpEmail';
import { internal } from './_generated/api';
import { emailAddress, invitationDelivery, type InvitationDelivery } from './invitationValidators';
const deliveryConcurrency = 5;
const batchTimeoutMs = 4 * 60_000;
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
			config = configuration();
		} catch {
			throw new ConvexError('Email is unavailable.');
		}
		const baseUrl = new URL('/invitation', config.appUrl);
		const inlineDeadline = Date.now() + batchTimeoutMs;
		const sockets = new Set<TLSSocket>();
		let timedOut = false;
		const transport = nodemailer.createTransport({
			pool: true,
			maxConnections: deliveryConcurrency,
			maxRequeues: 0,
			...transportOptions(config),
			// Own sockets so the batch deadline also cancels active SMTP exchanges.
			getSocket(
				_options: SMTPTransport.Options,
				callback: Parameters<NonNullable<SMTPTransport.Options['getSocket']>>[1]
			) {
				if (timedOut) return callback(new Error('Invitation batch timed out.'));
				const socket = connect({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com' });
				const connectionTimer = setTimeout(
					() => socket.destroy(new Error('SMTP connection timed out.')),
					30_000
				);
				sockets.add(socket);
				let handedOff = false;
				const failed = (error: Error) => {
					if (handedOff) return;
					handedOff = true;
					callback(error);
				};
				socket.once('close', () => {
					clearTimeout(connectionTimer);
					sockets.delete(socket);
					failed(new Error('SMTP connection closed.'));
				});
				socket.once('error', failed);
				socket.once('secureConnect', () => {
					if (handedOff) return;
					handedOff = true;
					clearTimeout(connectionTimer);
					socket.removeListener('error', failed);
					callback(null, { connection: socket, secured: true });
				});
			}
		});
		const timer = setTimeout(() => {
			timedOut = true;
			transport.close();
			for (const socket of sockets) socket.destroy(new Error('Invitation batch timed out.'));
		}, batchTimeoutMs);
		async function deliver(email: string): Promise<InvitationDelivery> {
			try {
				const token = randomBytes(32).toString('base64url');
				const invitation = await ctx.runMutation(internal.companyInvitations.prepareDelivery, {
					membershipId: args.membershipId,
					email,
					resend: args.resend ?? false,
					inlineDeadline,
					tokenHash: createHash('sha256').update(token).digest('hex')
				});
				if (!invitation) return { email, error: null };
				const url = new URL(baseUrl);
				url.searchParams.set('invitation', token);
				const outcome = await deliverEmail(
					ctx,
					{ id: invitation.deliveryId, attempt: 1 },
					async () => ({
						subject: `Join ${invitation.companyName} on Dinu`,
						text: `${invitation.inviterName} invited you to join ${invitation.companyName} on Dinu.\n\n${url.href}\n\nOpen the invitation, verify ${invitation.email} with an email code, then choose Join ${invitation.companyName}. Your Dinu account will be created if needed. This invitation expires in 7 days.`
					}),
					{ transport, expired: () => timedOut }
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
				Array.from({ length: Math.min(deliveryConcurrency, emails.length) }, async () => {
					while (!timedOut && next < emails.length) {
						const index = next++;
						results[index] = await deliver(emails[index]);
					}
				})
			);
			return results;
		} finally {
			clearTimeout(timer);
			transport.close();
			for (const socket of sockets) socket.destroy();
		}
	}
});
