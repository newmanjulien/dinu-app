import { v, type Infer } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx } from './_generated/server';
import { availableCompany, liveCompanyMember } from './auth';
import { CLEANUP_DISCOVERY_PAGE_SIZE } from './cleanup';
import {
	emailAddress,
	emailAttempt,
	emailOutcome,
	emailRecipients,
	emailState,
	type EmailEvent,
	type EmailOutcome
} from './emailValidators';
import { completeInvitationDelivery } from './invitationDeliverySummary';
import schema from './schema';

const RECOVERY_INTERVAL = 60_000;
const DECISION_MAX_ATTEMPTS = 3;
export const UNCERTAIN_COOLDOWN = 10 * 60_000;
export const RETIRED_DELIVERY_RECHECK = RECOVERY_INTERVAL;
// Inline actions may run for ten minutes. Recovery waits beyond that hard limit,
// rather than treating the provider timeout or the resend cooldown as a lease.
const INLINE_RECOVERY_GRACE = 7 * 60_000;

type Delivery = Doc<'emailDeliveries'>;

export async function cancelJob(ctx: MutationCtx, id?: Id<'_scheduled_functions'>) {
	if (!id) return;
	const job = await ctx.db.system.get('_scheduled_functions', id);
	if (job?.state.kind === 'pending') await ctx.scheduler.cancel(id);
}

export function providerDispatchInProgress(delivery: Delivery) {
	return delivery.state.kind === 'sending' && delivery.state.dispatch.kind === 'dispatching';
}

export async function cancelDelivery(ctx: MutationCtx, delivery: Delivery) {
	// Once the action has crossed the final provider-dispatch barrier, preserve it
	// and its recovery job until its outcome is recorded.
	if (!providerDispatchInProgress(delivery)) {
		if (delivery.execution.kind === 'scheduled') await cancelJob(ctx, delivery.execution.sendJobId);
		await cancelJob(ctx, delivery.execution.recoveryJobId);
	}
}

export async function retireDelivery(
	ctx: MutationCtx,
	delivery: Delivery
): Promise<'ready' | 'inFlight'> {
	if (providerDispatchInProgress(delivery)) return 'inFlight';
	await cancelDelivery(ctx, delivery);
	return 'ready';
}

export async function removeDelivery(ctx: MutationCtx, delivery: Delivery) {
	if ((await retireDelivery(ctx, delivery)) === 'ready')
		await ctx.db.delete('emailDeliveries', delivery._id);
}

export async function activeJob(ctx: QueryCtx, id?: Id<'_scheduled_functions'>) {
	const job = id ? await ctx.db.system.get('_scheduled_functions', id) : null;
	return job?.state.kind === 'pending' || job?.state.kind === 'inProgress';
}

export async function activeDelivery(ctx: MutationCtx, delivery: Delivery) {
	if (delivery.execution.kind === 'scheduled') return activeJob(ctx, delivery.execution.sendJobId);
	return (
		delivery.state.kind === 'sending' &&
		Date.now() < delivery.execution.deadline + INLINE_RECOVERY_GRACE
	);
}

async function scheduleRecovery(
	ctx: MutationCtx,
	delivery: Delivery,
	when = Date.now() + RECOVERY_INTERVAL
) {
	const recoveryJobId = await ctx.scheduler.runAt(when, internal.emailDeliveries.recover, {
		id: delivery._id,
		attempt: delivery.attempt
	});
	await ctx.db.patch(
		'emailDeliveries',
		delivery._id,
		delivery.execution.kind === 'scheduled'
			? { execution: { ...delivery.execution, recoveryJobId } }
			: { execution: { ...delivery.execution, recoveryJobId } }
	);
}

/** Inline invitation delivery keeps its existing attempt/recovery lifetime. */
export async function createDelivery(
	ctx: MutationCtx,
	data: {
		companyId: Id<'company'>;
		event: Extract<EmailEvent, { kind: 'invitation' }>;
		inlineDeadline: number;
	}
) {
	const value = {
		companyId: data.companyId,
		event: data.event,
		attempt: 1,
		state: { kind: 'sending' as const, dispatch: { kind: 'pending' as const } },
		execution: { kind: 'inline' as const, deadline: data.inlineDeadline }
	};
	const id = await ctx.db.insert('emailDeliveries', value);
	const recoveryJobId = await ctx.scheduler.runAt(
		data.inlineDeadline + INLINE_RECOVERY_GRACE,
		internal.emailDeliveries.recover,
		{ id, attempt: 1 }
	);
	await ctx.db.patch('emailDeliveries', id, { execution: { ...value.execution, recoveryJobId } });
	return id;
}

/** Scheduled contract review delivery (approval request or decision completion). */
export async function createContractDelivery(
	ctx: MutationCtx,
	data: {
		companyId: Id<'company'>;
		contractId: Id<'savedContracts'>;
		event: Exclude<EmailEvent, { kind: 'invitation' }>;
	}
) {
	const id = await ctx.db.insert('emailDeliveries', {
		companyId: data.companyId,
		contractId: data.contractId,
		event: data.event,
		attempt: 1,
		state: { kind: 'sending' as const, dispatch: { kind: 'pending' as const } },
		execution: { kind: 'scheduled' as const }
	});
	const sendJobId = await ctx.scheduler.runAfter(0, internal.contractEmail.send, {
		id,
		attempt: 1
	});
	const recoveryJobId = await ctx.scheduler.runAt(
		Date.now() + RECOVERY_INTERVAL,
		internal.emailDeliveries.recover,
		{ id, attempt: 1 }
	);
	await ctx.db.patch('emailDeliveries', id, {
		execution: { kind: 'scheduled', sendJobId, recoveryJobId }
	});
	return id;
}

async function eligibleTarget(ctx: QueryCtx, delivery: Delivery) {
	const company = await availableCompany(ctx, delivery.companyId);
	if (!company) return null;
	const event = delivery.event;
	if (event.kind === 'invitation') {
		if (delivery.execution.kind !== 'inline') throw new Error('Invitation execution is invalid.');
		const invitation = await ctx.db.get('companyInvitations', event.invitationId);
		return invitation?.companyId === delivery.companyId &&
			invitation.status === 'pending' &&
			!invitation.expired &&
			invitation.expiresAt > Date.now() &&
			invitation.deliveryGeneration === event.generation &&
			invitation.deliveryId === delivery._id &&
			Date.now() < delivery.execution.deadline
			? { kind: 'invitation' as const, invitation }
			: null;
	}
	const [contract, deletion] = await Promise.all([
		ctx.db.get('savedContracts', event.contractId),
		ctx.db
			.query('contractCleanups')
			.withIndex('by_contractId', (q) => q.eq('contractId', event.contractId))
			.unique()
	]);
	if (!contract || deletion || contract.companyId !== delivery.companyId) return null;
	if (event.kind === 'approval') {
		if (
			contract.review.generation !== event.generation ||
			contract.review.request?.deliveryId !== delivery._id
		)
			return null;
		const hasPending = contract.concessions.some((c) => c.status === 'pending');
		return hasPending ? { kind: 'contract' as const, contract, company } : null;
	}
	if (
		contract.review.generation !== event.generation ||
		contract.review.completion?.kind !== 'queued' ||
		contract.review.completion.deliveryId !== delivery._id
	)
		return null;
	return { kind: 'contract' as const, contract, company };
}

function pendingAttempt(delivery: Delivery | null, attempt: number) {
	return Boolean(delivery && delivery.attempt === attempt && delivery.state.kind === 'sending');
}

async function memberEmail(ctx: QueryCtx, companyId: Id<'company'>, profileId: Id<'profiles'>) {
	const profile = await liveCompanyMember(ctx, companyId, profileId);
	if (!profile) return null;
	try {
		return emailAddress(profile.email);
	} catch {
		return null;
	}
}

async function recipients(
	ctx: QueryCtx,
	delivery: Delivery,
	target: { contract: Doc<'savedContracts'>; company: Doc<'company'> } | null
) {
	if (delivery.event.kind === 'invitation') {
		try {
			return { recipientEmail: emailAddress(delivery.event.recipientEmail), cc: [] };
		} catch {
			return null;
		}
	}
	if (!target) return null;
	if (delivery.event.kind === 'approval') {
		if (!target.company.approvalEmail) return null;
		try {
			return { recipientEmail: emailAddress(target.company.approvalEmail), cc: [] };
		} catch {
			return null;
		}
	}
	const creatorId = target.contract.creatorId;
	const recipientEmail = await memberEmail(ctx, delivery.companyId, creatorId);
	if (!recipientEmail) return null;
	const reviewerEmail =
		delivery.event.reviewerId === creatorId
			? null
			: await memberEmail(ctx, delivery.companyId, delivery.event.reviewerId);
	return {
		recipientEmail,
		cc: reviewerEmail && reviewerEmail !== recipientEmail ? [reviewerEmail] : []
	};
}

export const prepare = internalMutation({
	args: emailAttempt.fields,
	returns: v.union(schema.doc('emailDeliveries'), v.null()),
	handler: async (ctx, args) => {
		const delivery = await ctx.db.get('emailDeliveries', args.id);
		if (
			!pendingAttempt(delivery, args.attempt) ||
			!delivery ||
			delivery.state.dispatch?.kind !== 'pending'
		)
			return null;
		const target = await eligibleTarget(ctx, delivery);
		return target ? delivery : null;
	}
});

const sendGate = v.union(
	v.object({ status: v.literal('ready'), recipients: emailRecipients }),
	v.null()
);

async function isOrphanedContractDelivery(ctx: QueryCtx, delivery: Delivery) {
	if (delivery.event.kind === 'invitation') return false;
	const contract = await ctx.db.get('savedContracts', delivery.event.contractId);
	if (!contract || contract.companyId !== delivery.companyId) return true;
	if (delivery.event.kind === 'approval')
		return contract.review.request?.deliveryId !== delivery._id;
	return (
		contract.review.completion?.kind !== 'queued' ||
		contract.review.completion.deliveryId !== delivery._id
	);
}

export const claim = internalMutation({
	args: emailAttempt.fields,
	returns: sendGate,
	handler: async (ctx, args) => {
		const delivery = await ctx.db.get('emailDeliveries', args.id);
		if (
			!pendingAttempt(delivery, args.attempt) ||
			!delivery ||
			delivery.state.dispatch?.kind !== 'pending'
		)
			return null;
		const target = await eligibleTarget(ctx, delivery);
		const to = target
			? await recipients(ctx, delivery, target.kind === 'contract' ? target : null)
			: null;
		if (!to) {
			await cancelJob(ctx, delivery.execution.recoveryJobId);
			if (await isOrphanedContractDelivery(ctx, delivery))
				await ctx.db.delete('emailDeliveries', delivery._id);
			else await recordOutcome(ctx, delivery, { status: 'skipped' });
			return null;
		}
		await ctx.db.patch('emailDeliveries', delivery._id, {
			state: { kind: 'sending', dispatch: { kind: 'claimed', ...to } }
		});
		return { status: 'ready' as const, recipients: to };
	}
});

export const beginDispatch = internalMutation({
	args: emailAttempt.fields,
	returns: sendGate,
	handler: async (ctx, args) => {
		const delivery = await ctx.db.get('emailDeliveries', args.id);
		if (
			!pendingAttempt(delivery, args.attempt) ||
			!delivery ||
			delivery.state.dispatch?.kind !== 'claimed'
		)
			return null;
		const target = await eligibleTarget(ctx, delivery);
		const to = target
			? await recipients(ctx, delivery, target.kind === 'contract' ? target : null)
			: null;
		if (!to) {
			await cancelJob(ctx, delivery.execution.recoveryJobId);
			if (await isOrphanedContractDelivery(ctx, delivery))
				await ctx.db.delete('emailDeliveries', delivery._id);
			else await recordOutcome(ctx, delivery, { status: 'skipped' });
			return null;
		}
		await ctx.db.patch('emailDeliveries', delivery._id, {
			state: { kind: 'sending', dispatch: { kind: 'dispatching', ...to } }
		});
		return { status: 'ready' as const, recipients: to };
	}
});

async function recordOutcome(ctx: MutationCtx, delivery: Delivery, outcome: EmailOutcome) {
	const details = {
		completedAt: Date.now(),
		dispatch: delivery.state.dispatch?.kind === 'pending' ? undefined : delivery.state.dispatch,
		error: outcome.error
	};
	const state: Infer<typeof emailState> =
		outcome.status === 'failed'
			? { ...details, kind: 'failed', retryable: outcome.retryable ?? false }
			: outcome.status === 'uncertain'
				? { ...details, kind: 'uncertain', retryEligible: false }
				: { ...details, kind: outcome.status };
	await ctx.db.patch('emailDeliveries', delivery._id, { state });
	await completeInvitationDelivery(ctx, delivery, outcome.status);
	return { ...delivery, state };
}

export const complete = internalMutation({
	args: { ...emailAttempt.fields, outcome: emailOutcome, dispatched: v.boolean() },
	returns: v.null(),
	handler: async (ctx, { id, attempt, outcome, dispatched }) => {
		const delivery = await ctx.db.get('emailDeliveries', id);
		if (
			!delivery ||
			delivery.attempt !== attempt ||
			(delivery.state.kind !== 'sending' && delivery.state.kind !== 'uncertain')
		)
			return null;
		if (!dispatched && delivery.state.dispatch?.kind !== 'pending') return null;
		if (delivery.state.kind === 'uncertain' && outcome.status !== 'sent') return null;
		await cancelJob(ctx, delivery.execution.recoveryJobId);
		if (await isOrphanedContractDelivery(ctx, delivery)) {
			await ctx.db.delete('emailDeliveries', delivery._id);
			return null;
		}
		await recordOutcome(ctx, delivery, outcome);
		if (
			(delivery.event.kind === 'decision' &&
				outcome.status === 'failed' &&
				outcome.retryable &&
				attempt < DECISION_MAX_ATTEMPTS) ||
			(delivery.event.kind === 'approval' && outcome.status === 'uncertain')
		)
			await scheduleRecovery(
				ctx,
				delivery,
				Date.now() + (outcome.status === 'uncertain' ? UNCERTAIN_COOLDOWN : 1000)
			);
		return null;
	}
});

export const recover = internalMutation({
	args: emailAttempt.fields,
	returns: v.null(),
	handler: async (ctx, { id, attempt }): Promise<null> => {
		let delivery = await ctx.db.get('emailDeliveries', id);
		if (
			!delivery ||
			delivery.attempt !== attempt ||
			['sent', 'skipped'].includes(delivery.state.kind)
		)
			return null;
		if (await activeDelivery(ctx, delivery)) {
			await scheduleRecovery(ctx, delivery);
			return null;
		}
		if (await isOrphanedContractDelivery(ctx, delivery)) {
			await ctx.db.delete('emailDeliveries', delivery._id);
			return null;
		}
		if (delivery.state.kind === 'sending') {
			const outcome: EmailOutcome =
				delivery.state.dispatch.kind === 'claimed' || delivery.state.dispatch.kind === 'dispatching'
					? {
							status: 'uncertain',
							error:
								'Email delivery could not be confirmed; another attempt may deliver a duplicate email.'
						}
					: {
							status: 'failed',
							error: 'The email stopped before dispatch.',
							retryable: true
						};
			delivery = await recordOutcome(ctx, delivery, outcome);
			console.warn('email_delivery', {
				id,
				attempt,
				stage: 'recovery',
				status: delivery.state.kind
			});
		}
		if (
			delivery.event.kind === 'decision' &&
			delivery.state.kind === 'failed' &&
			delivery.state.retryable &&
			attempt < DECISION_MAX_ATTEMPTS
		) {
			if (!(await restartDelivery(ctx, delivery, true)))
				await recordOutcome(ctx, delivery, { status: 'skipped' });
		} else if (
			delivery.event.kind === 'approval' &&
			delivery.state.kind === 'uncertain' &&
			!delivery.state.retryEligible
		) {
			const retryAt = delivery.state.completedAt + UNCERTAIN_COOLDOWN;
			if (Date.now() >= retryAt)
				await ctx.db.patch('emailDeliveries', id, {
					state: { ...delivery.state, retryEligible: true }
				});
			else await scheduleRecovery(ctx, delivery, retryAt);
		}
		return null;
	}
});

function needsRecovery(delivery: Delivery) {
	const state = delivery.state;
	return (
		state.kind === 'sending' ||
		(state.kind === 'failed' &&
			delivery.event.kind === 'decision' &&
			state.retryable &&
			delivery.attempt < DECISION_MAX_ATTEMPTS) ||
		(state.kind === 'uncertain' && delivery.event.kind === 'approval' && !state.retryEligible)
	);
}

export const resumeOne = internalMutation({
	args: { id: v.id('emailDeliveries') },
	returns: v.null(),
	handler: async (ctx, { id }) => {
		const delivery = await ctx.db.get('emailDeliveries', id);
		if (
			delivery &&
			needsRecovery(delivery) &&
			!(await activeJob(ctx, delivery.execution.recoveryJobId))
		) {
			const when =
				delivery.state.kind === 'uncertain'
					? delivery.state.completedAt + UNCERTAIN_COOLDOWN
					: delivery.execution.kind === 'inline'
						? delivery.execution.deadline + INLINE_RECOVERY_GRACE
						: Date.now();
			await scheduleRecovery(ctx, delivery, Math.max(Date.now(), when));
		}
		return null;
	}
});

export const recoveryStates = ['sending', 'failed', 'uncertain'] as const;

export function recoveryRows(ctx: QueryCtx, state: (typeof recoveryStates)[number]) {
	return state === 'uncertain'
		? ctx.db
				.query('emailDeliveries')
				.withIndex('by_state_kind_and_event_kind_and_state_retryEligible', (q) =>
					q.eq('state.kind', state).eq('event.kind', 'approval').eq('state.retryEligible', false)
				)
		: ctx.db
				.query('emailDeliveries')
				.withIndex('by_state_kind_and_event_kind_and_state_retryable_and_attempt', (q) =>
					state === 'sending'
						? q.eq('state.kind', state)
						: q
								.eq('state.kind', state)
								.eq('event.kind', 'decision')
								.eq('state.retryable', true)
								.lt('attempt', DECISION_MAX_ATTEMPTS)
				);
}

export const resume = internalMutation({
	args: {
		state: v.union(...recoveryStates.map((state) => v.literal(state))),
		cursor: v.optional(v.union(v.string(), v.null()))
	},
	returns: v.null(),
	handler: async (ctx, { state, cursor }) => {
		const rows = recoveryRows(ctx, state);
		const result = await rows.paginate({
			cursor: cursor ?? null,
			numItems: CLEANUP_DISCOVERY_PAGE_SIZE,
			maximumRowsRead: CLEANUP_DISCOVERY_PAGE_SIZE,
			maximumBytesRead: 2 * 1024 * 1024
		});
		for (const delivery of result.page) {
			if (!needsRecovery(delivery)) continue;
			try {
				await ctx.runMutation(internal.emailDeliveries.resumeOne, { id: delivery._id });
			} catch (error) {
				console.error('Unable to resume email delivery recovery', delivery._id, error);
			}
		}
		if (!result.isDone)
			await ctx.scheduler.runAfter(0, internal.emailDeliveries.resume, {
				state,
				cursor: result.continueCursor
			});
		return null;
	}
});

export async function restartDelivery(
	ctx: MutationCtx,
	delivery: Delivery,
	fromRecovery = false,
	updatedEvent?: Exclude<EmailEvent, { kind: 'invitation' }>
) {
	const explicitApprovalRetry =
		delivery.event.kind === 'approval' &&
		delivery.state.kind === 'uncertain' &&
		delivery.state.retryEligible;
	if (
		delivery.execution.kind !== 'scheduled' ||
		(delivery.state.kind !== 'failed' && !explicitApprovalRetry) ||
		(await activeDelivery(ctx, delivery)) ||
		!(await eligibleTarget(ctx, delivery))
	)
		return false;
	if (!fromRecovery) await cancelJob(ctx, delivery.execution.recoveryJobId);
	const attempt = delivery.attempt + 1;
	const sendJobId = await ctx.scheduler.runAfter(0, internal.contractEmail.send, {
		id: delivery._id,
		attempt
	});
	const recoveryJobId = await ctx.scheduler.runAfter(
		RECOVERY_INTERVAL,
		internal.emailDeliveries.recover,
		{
			id: delivery._id,
			attempt
		}
	);
	await ctx.db.patch('emailDeliveries', delivery._id, {
		...(updatedEvent ? { event: updatedEvent } : {}),
		attempt,
		execution: { kind: 'scheduled', sendJobId, recoveryJobId },
		state: { kind: 'sending', dispatch: { kind: 'pending' } }
	});
	return true;
}

export const retry = internalMutation({
	args: { id: v.id('emailDeliveries') },
	returns: v.boolean(),
	handler: async (ctx, { id }) => {
		const delivery = await ctx.db.get('emailDeliveries', id);
		return delivery?.event.kind === 'decision' && delivery.state.kind === 'failed'
			? restartDelivery(ctx, delivery)
			: false;
	}
});
