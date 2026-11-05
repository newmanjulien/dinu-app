import { v, type Infer } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { availableCompany, liveCompanyMember } from './auth';
import {
	emailAttempt,
	emailOutcome,
	emailRecipients,
	emailAddress,
	emailSelection,
	type EmailOutcome,
	type EmailEvent,
	emailState
} from './emailValidators';
import { storeSelections, selectionsFor } from './emailSnapshots';
import { completedReview, decisionSelections } from './reviews';
import schema from './schema';
import { CLEANUP_DISCOVERY_PAGE_SIZE } from './cleanup';

const RECOVERY_INTERVAL = 60_000;
const DECISION_MAX_ATTEMPTS = 3;
export const UNCERTAIN_COOLDOWN = 10 * 60_000;
export const RETIRED_DELIVERY_RECHECK = RECOVERY_INTERVAL;
// Inline actions may run for ten minutes. Recovery waits beyond that hard limit,
// rather than treating the provider timeout or the resend cooldown as a lease.
const INLINE_RECOVERY_GRACE = 7 * 60_000;

type Delivery = Doc<'emailDeliveries'>;
type NewDelivery = { companyId: Id<'company'> } & (
	| { event: Exclude<EmailEvent, { kind: 'invitation' }> }
	| { event: Extract<EmailEvent, { kind: 'invitation' }>; inlineDeadline: number }
);

export async function cancelJob(ctx: MutationCtx, id?: Id<'_scheduled_functions'>) {
	if (!id) return;
	const job = await ctx.db.system.get('_scheduled_functions', id);
	if (job?.state.kind === 'pending' || job?.state.kind === 'inProgress')
		await ctx.scheduler.cancel(id);
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
		await cancelJob(ctx, delivery.disposal?.jobId);
	}
}
export async function activeJob(ctx: QueryCtx, id?: Id<'_scheduled_functions'>) {
	const job = id ? await ctx.db.system.get('_scheduled_functions', id) : null;
	return job?.state.kind === 'pending' || job?.state.kind === 'inProgress';
}
export async function activeDelivery(ctx: MutationCtx, delivery: Delivery) {
	if (delivery.disposal && !providerDispatchInProgress(delivery)) return false;
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
	// Keep whole patch branches narrowed for Convex's union-table patch type.
	await ctx.db.patch(
		'emailDeliveries',
		delivery._id,
		delivery.execution.kind === 'scheduled'
			? { execution: { ...delivery.execution, recoveryJobId } }
			: { execution: { ...delivery.execution, recoveryJobId } }
	);
}
export async function createDelivery(
	ctx: MutationCtx,
	data: NewDelivery,
	selections?: Infer<typeof emailSelection>[]
) {
	const pending = {
		companyId: data.companyId,
		attempt: 1,
		state: { kind: 'sending' as const, dispatch: { kind: 'pending' as const } }
	};
	const value =
		'inlineDeadline' in data
			? {
					...pending,
					event: data.event,
					execution: { kind: 'inline' as const, deadline: data.inlineDeadline }
				}
			: {
					...pending,
					event: data.event,
					contractId: data.event.contractId,
					execution: { kind: 'scheduled' as const }
				};
	const id = await ctx.db.insert('emailDeliveries', value);
	if (selections) await storeSelections(ctx, data.companyId, id, selections);
	const sendJobId =
		value.execution.kind === 'scheduled'
			? await ctx.scheduler.runAfter(0, internal.contractEmail.send, {
					id,
					attempt: 1
				})
			: undefined;
	const recoveryJobId = await ctx.scheduler.runAt(
		value.execution.kind === 'inline'
			? value.execution.deadline + INLINE_RECOVERY_GRACE
			: Date.now() + RECOVERY_INTERVAL,
		internal.emailDeliveries.recover,
		{ id, attempt: 1 }
	);
	await ctx.db.patch(
		'emailDeliveries',
		id,
		value.execution.kind === 'inline'
			? { execution: { ...value.execution, recoveryJobId } }
			: { execution: { ...value.execution, sendJobId, recoveryJobId } }
	);
	return id;
}

async function eligibleContract(ctx: MutationCtx, delivery: Delivery) {
	if (!(await availableCompany(ctx, delivery.companyId))) return null;
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
			? invitation
			: null;
	}
	const contract = await ctx.db.get('savedContracts', event.contractId);
	if (
		!contract ||
		contract.companyId !== delivery.companyId ||
		contract.templateVersionId !== event.templateVersionId
	)
		return null;
	if (event.kind === 'decision') {
		const completion = contract.reviewCompletion;
		if (completion && (completion.kind !== 'queued' || completion.deliveryId !== delivery._id))
			return null;
		return contract.reviewGeneration === event.reviewGeneration && completedReview(contract)
			? contract
			: null;
	}
	const request = await ctx.db
		.query('approvalRequests')
		.withIndex('by_contractId', (q) => q.eq('contractId', event.contractId))
		.unique();
	return request?.id === event.requestId && request.deliveryId === delivery._id ? contract : null;
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
async function recipients(ctx: QueryCtx, delivery: Delivery, creatorId?: Id<'profiles'>) {
	if (delivery.event.kind !== 'decision') {
		try {
			return { recipientEmail: emailAddress(delivery.event.recipientEmail), cc: [] };
		} catch {
			return null;
		}
	}
	if (!creatorId) return null;
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

/** Freeze bounded snapshots outside the decision transaction; check cheap eligibility first. */
export const prepare = internalMutation({
	args: emailAttempt.fields,
	returns: v.union(
		v.object({ delivery: schema.doc('emailDeliveries'), selections: v.array(emailSelection) }),
		v.null()
	),
	handler: async (ctx, args) => {
		const delivery = await ctx.db.get('emailDeliveries', args.id);
		if (
			!delivery ||
			delivery.disposal ||
			delivery.attempt !== args.attempt ||
			delivery.state.kind !== 'sending' ||
			delivery.state.dispatch.kind !== 'pending'
		)
			return null;
		const context = await eligibleContract(ctx, delivery);
		if (!context) return null;
		if (
			delivery.event.kind === 'decision' &&
			(!('creatorId' in context) ||
				!(await memberEmail(ctx, delivery.companyId, context.creatorId)))
		)
			return null;
		let selections =
			delivery.event.kind === 'invitation' ? [] : await selectionsFor(ctx, delivery._id);
		if (delivery.event.kind === 'decision' && !selections.length && 'reviews' in context) {
			selections = decisionSelections(context);
			await storeSelections(ctx, delivery.companyId, delivery._id, selections);
		}
		return { delivery, selections };
	}
});
export const claim = internalMutation({
	args: emailAttempt.fields,
	returns: v.union(emailRecipients, v.null()),
	handler: async (ctx, args): Promise<Infer<typeof emailRecipients> | null> => {
		const delivery = await ctx.db.get('emailDeliveries', args.id);
		if (
			!delivery ||
			delivery.disposal ||
			delivery.attempt !== args.attempt ||
			delivery.state.kind !== 'sending' ||
			delivery.state.dispatch.kind !== 'pending'
		)
			return null;
		const context = await eligibleContract(ctx, delivery);
		const to = context
			? await recipients(ctx, delivery, 'creatorId' in context ? context.creatorId : undefined)
			: null;
		if (!to) {
			await recordOutcome(ctx, delivery, { status: 'skipped' });
			await cancelJob(ctx, delivery.execution.recoveryJobId);
			return null;
		}
		await ctx.db.patch('emailDeliveries', delivery._id, {
			state: { kind: 'sending', dispatch: { kind: 'claimed', ...to } }
		});
		return to;
	}
});
/** Revalidate immediately before an irreversible provider request. */
export const beginDispatch = internalMutation({
	args: emailAttempt.fields,
	returns: v.union(emailRecipients, v.null()),
	handler: async (ctx, args): Promise<Infer<typeof emailRecipients> | null> => {
		const delivery = await ctx.db.get('emailDeliveries', args.id);
		if (
			!delivery ||
			delivery.disposal ||
			delivery.attempt !== args.attempt ||
			delivery.state.kind !== 'sending' ||
			delivery.state.dispatch.kind !== 'claimed'
		)
			return null;
		const context = await eligibleContract(ctx, delivery);
		const to = context
			? await recipients(ctx, delivery, 'creatorId' in context ? context.creatorId : undefined)
			: null;
		if (!to) return null;
		await ctx.db.patch('emailDeliveries', delivery._id, {
			state: { kind: 'sending', dispatch: { kind: 'dispatching', ...to } }
		});
		return to;
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
	if (delivery.event.kind === 'invitation') {
		const invitation = await ctx.db.get('companyInvitations', delivery.event.invitationId);
		if (
			invitation?.deliveryId === delivery._id &&
			invitation.deliveryGeneration === delivery.event.generation
		)
			await ctx.db.patch('companyInvitations', invitation._id, {
				deliveryStatus: outcome.status === 'sent' ? 'sent' : 'failed'
			});
	}
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
		await recordOutcome(ctx, delivery, outcome);
		await cancelJob(ctx, delivery.execution.recoveryJobId);
		if (
			!delivery.disposal &&
			((delivery.event.kind === 'decision' &&
				outcome.status === 'failed' &&
				outcome.retryable &&
				attempt < DECISION_MAX_ATTEMPTS) ||
				(delivery.event.kind === 'approval' && outcome.status === 'uncertain'))
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
		if (delivery.disposal && !providerDispatchInProgress(delivery)) return null;
		if (await activeDelivery(ctx, delivery)) {
			await scheduleRecovery(ctx, delivery);
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
	if (delivery.disposal && !providerDispatchInProgress(delivery)) return false;
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

/** Restore the existing recovery rule, never infer failure from a missing job. */
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

/** The idle probe and paginated worker use the same work-only index ranges. */
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

/** Discover each unfinished family independently of sent history and Clerk access. */
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

/** Explicit retries reuse the event and snapshot, with a new guarded attempt. */
export async function restartDelivery(ctx: MutationCtx, delivery: Delivery, fromRecovery = false) {
	const explicitApprovalRetry =
		delivery.event.kind === 'approval' &&
		delivery.state.kind === 'uncertain' &&
		delivery.state.retryEligible;
	if (
		delivery.disposal ||
		delivery.execution.kind !== 'scheduled' ||
		(delivery.state.kind !== 'failed' && !explicitApprovalRetry) ||
		(await activeDelivery(ctx, delivery)) ||
		!(await eligibleContract(ctx, delivery))
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
		// Decision uncertainty must never be automatically resent.
		return delivery?.event.kind === 'decision' && delivery.state.kind === 'failed'
			? restartDelivery(ctx, delivery)
			: false;
	}
});
