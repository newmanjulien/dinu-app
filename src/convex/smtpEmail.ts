'use node';

import nodemailer from 'nodemailer';
import { env, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Infer } from 'convex/values';
import { emailAddress, type EmailOutcome, type emailAttempt } from './emailValidators';
import type { Doc } from './_generated/dataModel';
import type { EmailSelection } from './emailValidators';

class ConfigurationError extends Error {}
export class RecipientRejected extends Error {}

export function configuration() {
	const values = {
		APP_URL: env.APP_URL?.trim(),
		SMTP_USER: env.SMTP_USER?.trim(),
		SMTP_APP_PASSWORD: env.SMTP_APP_PASSWORD?.trim()
	};
	const missing = Object.entries(values)
		.filter(([, value]) => !value)
		.map(([key]) => key);
	if (missing.length)
		throw new ConfigurationError(
			`Email is not configured. Missing backend environment variables: ${missing.join(', ')}.`
		);
	let url: URL;
	try {
		url = new URL(values.APP_URL!);
	} catch {
		throw new ConfigurationError('APP_URL must be a valid HTTP or HTTPS app URL.');
	}
	if (
		!['https:', 'http:'].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== '/'
	)
		throw new ConfigurationError(
			'APP_URL must be an HTTP or HTTPS app URL origin without credentials, a path, a query, or a fragment.'
		);
	let user: string;
	try {
		user = emailAddress(values.SMTP_USER!);
	} catch {
		throw new ConfigurationError('SMTP_USER must be a plain email address.');
	}
	return {
		appUrl: url.origin,
		user,
		password: values.SMTP_APP_PASSWORD!
	};
}

const ERROR_CODES = new Set([
	'EAUTH',
	'EENVELOPE',
	'EMESSAGE',
	'ESTREAM',
	'ETLS',
	'EPROTOCOL',
	'ECONNECTION',
	'ESOCKET',
	'ETIMEDOUT',
	'ECONNRESET',
	'ECONNREFUSED',
	'ECONNABORTED',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'EDNS',
	'ENOTFOUND',
	'EAI_AGAIN'
]);
const SMTP_COMMANDS = new Set([
	'API',
	'CONN',
	'CONNECT',
	'EHLO',
	'HELO',
	'STARTTLS',
	'AUTH',
	'AUTH PLAIN',
	'AUTH LOGIN',
	'AUTH XOAUTH2',
	'MAIL FROM',
	'RCPT TO',
	'DATA',
	'RSET',
	'QUIT'
]);
export function diagnostics(cause: unknown) {
	const error =
		typeof cause === 'object' && cause !== null
			? (cause as { code?: unknown; command?: unknown; responseCode?: unknown })
			: {};
	return {
		...(typeof error.code === 'string' && ERROR_CODES.has(error.code) ? { code: error.code } : {}),
		...(typeof error.command === 'string' && SMTP_COMMANDS.has(error.command)
			? { command: error.command }
			: {}),
		...(typeof error.responseCode === 'number' &&
		Number.isInteger(error.responseCode) &&
		error.responseCode >= 100 &&
		error.responseCode < 600
			? { responseCode: error.responseCode }
			: {})
	};
}

export function failure(cause: unknown, dispatched: boolean): EmailOutcome {
	const diagnostic = diagnostics(cause);
	const connectionFailed =
		typeof cause === 'object' &&
		cause !== null &&
		'syscall' in cause &&
		cause.syscall === 'connect';
	const rejected =
		cause instanceof RecipientRejected ||
		(diagnostic.responseCode !== undefined &&
			diagnostic.responseCode >= 400 &&
			['AUTH', 'AUTH PLAIN', 'AUTH LOGIN', 'AUTH XOAUTH2', 'MAIL FROM', 'RCPT TO', 'DATA'].includes(
				diagnostic.command ?? ''
			));
	const confirmed =
		!dispatched ||
		connectionFailed ||
		rejected ||
		['EAUTH', 'EENVELOPE', 'EDNS'].includes(diagnostic.code ?? '') ||
		(diagnostic.code === 'EMESSAGE' && ['API', 'MAIL FROM'].includes(diagnostic.command ?? ''));
	if (!confirmed)
		return {
			status: 'uncertain',
			error: 'Gmail delivery could not be confirmed; another attempt may deliver a duplicate email.'
		};
	if (cause instanceof ConfigurationError) return { status: 'failed', error: cause.message };
	const permanent =
		['EAUTH', 'EENVELOPE', 'EMESSAGE'].includes(diagnostic.code ?? '') ||
		cause instanceof RecipientRejected ||
		(diagnostic.responseCode ?? 0) >= 500;
	return {
		status: 'failed',
		retryable: !permanent,
		error:
			diagnostic.code === 'EAUTH'
				? 'Gmail authentication failed. Check SMTP_USER and SMTP_APP_PASSWORD.'
				: rejected || diagnostic.code === 'EENVELOPE'
					? 'Gmail rejected the email. Check the sender and recipient addresses.'
					: 'The email could not be delivered. Check the Gmail configuration and recipient addresses.'
	};
}

export function transportOptions(config: ReturnType<typeof configuration>) {
	return {
		host: 'smtp.gmail.com',
		port: 465,
		secure: true,
		auth: { user: config.user, pass: config.password },
		connectionTimeout: 30_000,
		greetingTimeout: 30_000,
		socketTimeout: 60_000
	};
}
export function createTransport(config: ReturnType<typeof configuration>) {
	return nodemailer.createTransport(transportOptions(config));
}
function address(value: unknown) {
	if (typeof value === 'string') return value.trim().toLowerCase();
	return typeof value === 'object' &&
		value !== null &&
		'address' in value &&
		typeof value.address === 'string'
		? value.address.trim().toLowerCase()
		: '';
}

/** One sender for scheduled contract mail and inline invitation workers. */
export async function deliverEmail(
	ctx: ActionCtx,
	args: Infer<typeof emailAttempt>,
	content: (
		config: ReturnType<typeof configuration>,
		delivery: Doc<'emailDeliveries'>,
		selections: EmailSelection[]
	) => Promise<{ subject: string; text: string }>,
	options: { transport?: ReturnType<typeof createTransport>; expired?: () => boolean } = {}
): Promise<EmailOutcome | null> {
	let stage = 'prepare';
	let claimed = false;
	let smtpStarted = false;
	let transport = options.transport;
	let outcome: EmailOutcome;
	try {
		const prepared = await ctx.runMutation(internal.emailDeliveries.prepare, args);
		if (!prepared) outcome = { status: 'skipped' };
		else {
			stage = 'configuration';
			const config = configuration();
			stage = 'content';
			const mail = await content(config, prepared.delivery, prepared.selections);
			transport ??= createTransport(config);
			if (options.expired?.()) throw new Error('Email batch timed out.');
			stage = 'claim';
			// Never retry an ambiguous claim or proceed to SMTP after it fails.
			const recipients = await ctx.runMutation(internal.emailDeliveries.claim, args);
			if (!recipients) return null;
			claimed = true;
			stage = 'smtp';
			if (options.expired?.()) throw new Error('Email batch timed out.');
			smtpStarted = true;
			const result = await transport.sendMail({
				...mail,
				from: { address: config.user, name: 'Dinu' },
				to: { address: recipients.recipientEmail, name: '' },
				cc: recipients.cc.map((email) => ({ address: email, name: '' }))
			});
			if (!result.accepted.length) throw new RecipientRejected();
			const accepted = new Set(result.accepted.map(address));
			const rejected = [recipients.recipientEmail, ...recipients.cc].filter(
				(email) => !accepted.has(email)
			);
			const recipientAccepted = accepted.has(recipients.recipientEmail);
			outcome = {
				status: recipientAccepted && !rejected.length ? 'sent' : 'partial',
				messageId: result.messageId,
				recipientAccepted,
				rejected,
				...(rejected.length
					? {
							error: recipientAccepted
								? 'Gmail rejected one or more CC recipients.'
								: 'Gmail rejected the primary recipient.'
						}
					: {})
			};
			console.info('email_delivery', {
				...args,
				stage: 'gmail_accepted',
				status: outcome.status,
				recipientAccepted,
				rejectedCount: rejected.length
			});
		}
	} catch (cause) {
		console.warn('email_delivery', { ...args, stage, ...diagnostics(cause) });
		if (stage === 'claim')
			throw new Error(
				'Email dispatch claim could not be confirmed; recovery will resolve the attempt.'
			);
		outcome = failure(cause, smtpStarted);
	} finally {
		if (!options.transport) {
			try {
				transport?.close();
			} catch (cause) {
				console.warn('email_delivery', {
					...args,
					stage: 'close_transport',
					...diagnostics(cause)
				});
			}
		}
	}
	// Only result persistence is retried; SMTP is never repeated by this worker.
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await ctx.runMutation(internal.emailDeliveries.complete, {
				...args,
				outcome,
				dispatched: claimed
			});
			return outcome;
		} catch (cause) {
			console.warn('email_delivery', {
				...args,
				stage: 'persist_result',
				attempt: attempt + 1,
				...diagnostics(cause)
			});
			if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
		}
	}
	throw new Error('Email result could not be persisted; recovery will resolve the attempt.');
}

/** Four concurrent queries of sixteen bounded immutable items each. */
export async function loadDescriptions<Entry, Description>(
	entries: Entry[],
	load: (entries: Entry[]) => Promise<Description[]>
): Promise<Description[]> {
	const result: Description[] = [];
	for (let offset = 0; offset < entries.length; offset += 64) {
		const batches = await Promise.all(
			[0, 16, 32, 48]
				.filter((start) => offset + start < entries.length)
				.map((start) => load(entries.slice(offset + start, offset + start + 16)))
		);
		result.push(...batches.flat());
	}
	return result;
}
