import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Infer } from 'convex/values';
import { env } from './_generated/server';
import type { emailAttempt, emailRecipients, EmailOutcome } from './emailValidators';
import type { EmailNotification } from './emailNotifications';

class ConfigurationError extends Error {}
class ProviderError extends Error {
	constructor(readonly status: number) {
		super('Email provider request failed.');
	}
}

export function configuration(kind: EmailNotification['kind']) {
	const apiKey = env.LOOPS_API_KEY?.trim();
	const transactionalId = {
		invitation: env.LOOPS_INVITATION_ID,
		approval: env.LOOPS_APPROVAL_ID,
		decision: env.LOOPS_DECISION_ID
	}[kind]?.trim();
	if (!apiKey || !transactionalId || !env.APP_URL?.trim())
		throw new ConfigurationError('Email is unavailable.');
	let url: URL;
	try {
		url = new URL(env.APP_URL.trim());
	} catch {
		throw new ConfigurationError('Email is unavailable.');
	}
	if (
		!['https:', 'http:'].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== '/'
	)
		throw new ConfigurationError('Email is unavailable.');
	return { appUrl: url.origin, apiKey, transactionalId };
}

/** Keep provider bodies, message content, addresses and credentials out of logs. */
export function diagnostics(cause: unknown) {
	return cause instanceof ProviderError
		? { httpStatus: cause.status }
		: { reason: cause instanceof ConfigurationError ? 'configuration' : 'unconfirmed' };
}

export function failure(cause: unknown, sendStarted: boolean): EmailOutcome {
	// These responses explicitly reject the request. Other responses (including
	// an idempotency conflict), timeouts and network errors don't prove non-delivery.
	const rejected =
		cause instanceof ProviderError &&
		[400, 401, 403, 404, 405, 413, 422, 429].includes(cause.status);
	if (sendStarted && !rejected)
		return {
			status: 'uncertain',
			error: 'Email delivery could not be confirmed; another attempt may deliver a duplicate email.'
		};
	return {
		status: 'failed',
		error: 'Email is unavailable.',
		retryable:
			!(cause instanceof ConfigurationError) &&
			(!(cause instanceof ProviderError) || cause.status === 429)
	};
}

/** One HTTP request per claimed attempt; Loops accepts the request, not inbox delivery. */
export async function send(
	config: ReturnType<typeof configuration>,
	args: Infer<typeof emailAttempt>,
	mail: EmailNotification,
	recipients: Infer<typeof emailRecipients>,
	signal?: AbortSignal
): Promise<EmailOutcome> {
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (signal?.aborted) abort();
	else signal?.addEventListener('abort', abort, { once: true });
	const timer = setTimeout(abort, 60_000);
	try {
		// Include the deployment so snapshot copies cannot reuse another app's key.
		const idempotencyKey = `dinu:${bytesToHex(
			sha256(
				new TextEncoder().encode(JSON.stringify([env.CONVEX_CLOUD_URL, args.id, args.attempt]))
			)
		)}`;
		const response = await fetch('https://app.loops.so/api/v1/transactional', {
			method: 'POST',
			redirect: 'error',
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
				'Content-Type': 'application/json',
				'Idempotency-Key': idempotencyKey
			},
			body: JSON.stringify({
				transactionalId: config.transactionalId,
				email: recipients.recipientEmail,
				addToAudience: false,
				dataVariables: {
					...mail.data,
					...(mail.kind === 'decision' ? { cc: recipients.cc.join(',') } : {})
				}
			}),
			signal: controller.signal
		});
		if (!response.ok) throw new ProviderError(response.status);
		const result: unknown = await response.json();
		if (
			typeof result !== 'object' ||
			result === null ||
			!('success' in result) ||
			result.success !== true
		)
			throw new ProviderError(response.status);
		// The API supplies no message ID or individual To/CC acceptance evidence.
		return { status: 'sent' };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', abort);
	}
}
