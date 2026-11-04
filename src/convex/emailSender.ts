import { RateLimiter } from '@convex-dev/rate-limiter';
import type { Infer } from 'convex/values';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { components, internal } from './_generated/api';
import type { emailAttempt, EmailOutcome, EmailSelection } from './emailValidators';
import { configuration, send, diagnostics, failure } from './loopsEmail';
import type { EmailNotification } from './emailNotifications';

// Space this deployment's requests below Loops' shared ten-per-second baseline.
// Reservations bound waiting to one minute; this is a provider-work budget.
const rateLimiter = new RateLimiter(components.rateLimiter, {
	loops: { kind: 'token bucket', rate: 8, period: 1000, capacity: 1, maxReserved: 480 }
});

async function wait(milliseconds: number, signal?: AbortSignal) {
	if (signal?.aborted) throw new Error('Email batch timed out.');
	await new Promise<void>((resolve, reject) => {
		const abort = () => {
			clearTimeout(timer);
			reject(new Error('Email batch timed out.'));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', abort);
			resolve();
		}, milliseconds);
		signal?.addEventListener('abort', abort, { once: true });
	});
}

/** One sender for scheduled contract mail and inline invitation workers. */
export async function deliverEmail(
	ctx: ActionCtx,
	args: Infer<typeof emailAttempt>,
	content: (
		config: { appUrl: string },
		delivery: Doc<'emailDeliveries'>,
		selections: EmailSelection[]
	) => EmailNotification,
	options: { signal?: AbortSignal; deadline?: number } = {}
): Promise<EmailOutcome | null> {
	let stage = 'prepare';
	let claimed = false;
	let sendStarted = false;
	let outcome: EmailOutcome;
	const expired = () =>
		options.signal?.aborted || (options.deadline !== undefined && Date.now() >= options.deadline);
	try {
		const prepared = await ctx.runMutation(internal.emailDeliveries.prepare, args);
		if (!prepared) outcome = { status: 'skipped' };
		else {
			stage = 'configuration';
			const config = configuration(prepared.delivery.event.kind);
			stage = 'content';
			const mail = content(config, prepared.delivery, prepared.selections);
			if (mail.kind !== prepared.delivery.event.kind)
				throw new Error('Email notification does not match its delivery event.');
			if (expired()) throw new Error('Email batch timed out.');
			stage = 'provider_quota';
			const quota = await rateLimiter.limit(ctx, 'loops', { reserve: true });
			if (!quota.ok) throw new Error('Email provider quota is unavailable.');
			if (quota.retryAfter) await wait(quota.retryAfter, options.signal);
			if (expired()) throw new Error('Email batch timed out.');
			stage = 'claim';
			// Never retry an ambiguous claim or send after it fails.
			const claimedRecipients = await ctx.runMutation(internal.emailDeliveries.claim, args);
			if (!claimedRecipients) return null;
			claimed = true;
			stage = 'dispatch';
			const recipients = await ctx.runMutation(internal.emailDeliveries.beginDispatch, args);
			if (!recipients) return null;
			stage = 'provider';
			if (expired()) throw new Error('Email batch timed out.');
			sendStarted = true;
			outcome = await send(config, args, mail, recipients, options.signal);
			console.info('email_delivery', {
				...args,
				stage: 'provider_result',
				status: outcome.status
			});
		}
	} catch (cause) {
		console.warn('email_delivery', { ...args, stage, ...diagnostics(cause) });
		if (stage === 'claim')
			throw new Error(
				'Email dispatch claim could not be confirmed; recovery will resolve the attempt.'
			);
		outcome = failure(cause, sendStarted);
	}
	// Only result persistence is retried; the send is never repeated by this worker.
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
