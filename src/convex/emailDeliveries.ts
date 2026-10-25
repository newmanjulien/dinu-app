import { v, type Infer } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { availableCompany, liveProfile } from './auth';
import {
	emailAttempt,
	emailDelivery,
	emailOutcome,
	emailRecipients,
	emailAddress,
	emailSelection,
	type EmailOutcome
} from './emailValidators';
import { storeSelections, selectionsFor, deleteSelections } from './emailSnapshots';
import { completedReview, decisionSelections } from './decisionNotifications';
import schema from './schema';

const RECOVERY_INTERVAL = 60_000;
export const UNCERTAIN_COOLDOWN = 10 * 60_000;
// Inline actions may run for ten minutes. Recovery waits beyond that hard limit,
// rather than treating SMTP's inactivity timeout or the resend cooldown as a lease.
const INLINE_RECOVERY_GRACE = 7 * 60_000;

type Delivery = Doc<'emailDeliveries'>;
type NewDelivery = Pick<
	Infer<typeof emailDelivery>,
	'companyId' | 'event' | 'contractId' | 'recipientEmail' | 'inlineDeadline'
>;

export async function cancelJob(ctx: MutationCtx, id?: Id<'_scheduled_functions'>) {
	if (!id) return;
	const job = await ctx.db.system.get('_scheduled_functions', id);
	if (job?.state.kind === 'pending' || job?.state.kind === 'inProgress')
		await ctx.scheduler.cancel(id);
}
export async function cancelDelivery(ctx: MutationCtx, delivery: Delivery) {
	await cancelJob(ctx, delivery.sendJobId);
	await cancelJob(ctx, delivery.recoveryJobId);
}
export async function activeDelivery(ctx: QueryCtx, delivery: Delivery) {
	if (delivery.sendJobId) {
		const job = await ctx.db.system.get('_scheduled_functions', delivery.sendJobId);
		return job?.state.kind === 'pending' || job?.state.kind === 'inProgress';
	}
	return (
		delivery.status === 'sending' &&
		Date.now() < (delivery.inlineDeadline ?? 0) + INLINE_RECOVERY_GRACE
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
	await ctx.db.patch('emailDeliveries', delivery._id, { recoveryJobId });
}
export async function createDelivery(
	ctx: MutationCtx,
	data: NewDelivery,
	selections?: Infer<typeof emailSelection>[]
) {
	const id = await ctx.db.insert('emailDeliveries', {
		...data,
		status: 'sending',
		attempt: 1,
		dispatchStarted: false,
		retryable: false
	});
	if (selections) await storeSelections(ctx, data.companyId, id, selections);
	const delivery = (await ctx.db.get('emailDeliveries', id))!;
	if (data.event.kind !== 'invitation') {
		const sendJobId = await ctx.scheduler.runAfter(0, internal.contractEmail.send, {
			id,
			attempt: 1
		});
		await ctx.db.patch('emailDeliveries', id, { sendJobId });
	}
	await scheduleRecovery(
		ctx,
		delivery,
		data.event.kind === 'invitation'
			? (data.inlineDeadline ?? Date.now()) + INLINE_RECOVERY_GRACE
			: undefined
	);
	return id;
}

async function eligibleContract(ctx: QueryCtx, delivery: Delivery) {
	if (!(await availableCompany(ctx, delivery.companyId))) return null;
	const event = delivery.event;
	if (event.kind === 'invitation') {
		const invitation = await ctx.db.get('companyInvitations', event.invitationId);
		return invitation?.companyId === delivery.companyId &&
			invitation.status === 'pending' &&
			!invitation.expired &&
			invitation.expiresAt > Date.now() &&
			invitation.deliveryGeneration === event.generation &&
			invitation.deliveryId === delivery._id &&
			Date.now() < (delivery.inlineDeadline ?? 0)
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
	if (event.kind === 'decision')
		return (contract.reviewGeneration ?? 0) === event.reviewGeneration && completedReview(contract)
			? contract
			: null;
	const request = await ctx.db
		.query('approvalRequests')
		.withIndex('by_contractId', (q) => q.eq('contractId', event.contractId))
		.unique();
	return request?.id === event.requestId &&
		'deliveryId' in request &&
		request.deliveryId === delivery._id
		? contract
		: null;
}
async function memberEmail(ctx: QueryCtx, companyId: Id<'company'>, profileId: Id<'profiles'>) {
	const [profile, membership] = await Promise.all([
		liveProfile(ctx, profileId),
		ctx.db
			.query('memberships')
			.withIndex('by_profileId', (q) => q.eq('profileId', profileId))
			.unique()
	]);
	if (!profile || membership?.companyId !== companyId) return null;
	try {
		return emailAddress(profile.email);
	} catch {
		return null;
	}
}
async function recipients(
	ctx: QueryCtx,
	delivery: Delivery,
	selections: Infer<typeof emailSelection>[],
	creatorId?: Id<'profiles'>
) {
	if (delivery.event.kind !== 'decision') {
		try {
			return { recipientEmail: emailAddress(delivery.recipientEmail ?? ''), cc: [] };
		} catch {
			return null;
		}
	}
	if (!creatorId) return null;
	const recipientEmail = await memberEmail(ctx, delivery.companyId, creatorId);
	if (!recipientEmail) return null;
	const reviewerIds = [
		...new Set(
			selections.flatMap((s) => (s.reviewerId && s.reviewerId !== creatorId ? [s.reviewerId] : []))
		)
	];
	const cc = new Set<string>();
	for (let offset = 0; offset < reviewerIds.length; offset += 16) {
		const emails = await Promise.all(
			reviewerIds.slice(offset, offset + 16).map((id) => memberEmail(ctx, delivery.companyId, id))
		);
		for (const email of emails) if (email && email !== recipientEmail) cc.add(email);
	}
	return { recipientEmail, cc: [...cc] };
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
			delivery.attempt !== args.attempt ||
			delivery.status !== 'sending' ||
			delivery.dispatchStarted
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
		let selections = await selectionsFor(ctx, delivery._id);
		if (delivery.event.kind === 'decision' && !selections.length && 'reviews' in context) {
			selections = await decisionSelections(ctx, context);
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
			delivery.attempt !== args.attempt ||
			delivery.status !== 'sending' ||
			delivery.dispatchStarted
		)
			return null;
		const context = await eligibleContract(ctx, delivery);
		const to = context
			? await recipients(
					ctx,
					delivery,
					await selectionsFor(ctx, delivery._id),
					'creatorId' in context ? context.creatorId : undefined
				)
			: null;
		if (!to) {
			await recordOutcome(ctx, delivery, { status: 'skipped' });
			await cancelJob(ctx, delivery.recoveryJobId);
			return null;
		}
		await ctx.db.patch('emailDeliveries', delivery._id, { dispatchStarted: true, ...to });
		return to;
	}
});
async function recordOutcome(ctx: MutationCtx, delivery: Delivery, outcome: EmailOutcome) {
	await ctx.db.patch('emailDeliveries', delivery._id, {
		status: outcome.status,
		completedAt: Date.now(),
		error: outcome.error,
		messageId: outcome.messageId,
		recipientAccepted: outcome.recipientAccepted,
		rejected: outcome.rejected,
		retryable: outcome.retryable ?? false
	});
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
}
export const complete = internalMutation({
	args: { ...emailAttempt.fields, outcome: emailOutcome, dispatched: v.boolean() },
	returns: v.null(),
	handler: async (ctx, { id, attempt, outcome, dispatched }) => {
		const delivery = await ctx.db.get('emailDeliveries', id);
		if (
			!delivery ||
			delivery.attempt !== attempt ||
			!['sending', 'uncertain'].includes(delivery.status)
		)
			return null;
		if (!dispatched && delivery.dispatchStarted) return null;
		if (delivery.status === 'uncertain' && !['sent', 'partial'].includes(outcome.status))
			return null;
		await recordOutcome(ctx, delivery, outcome);
		await cancelJob(ctx, delivery.recoveryJobId);
		if (
			(delivery.event.kind === 'decision' &&
				outcome.status === 'failed' &&
				outcome.retryable &&
				attempt < 3) ||
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
			['sent', 'partial', 'skipped'].includes(delivery.status)
		)
			return null;
		if (await activeDelivery(ctx, delivery)) {
			await scheduleRecovery(ctx, delivery);
			return null;
		}
		if (delivery.status === 'sending') {
			const outcome: EmailOutcome = delivery.dispatchStarted
				? {
						status: 'uncertain',
						error:
							'Gmail delivery could not be confirmed; another attempt may deliver a duplicate email.'
					}
				: { status: 'failed', error: 'The email stopped before Gmail dispatch.', retryable: true };
			await recordOutcome(ctx, delivery, outcome);
			delivery = (await ctx.db.get('emailDeliveries', id))!;
			console.warn('email_delivery', { id, attempt, stage: 'recovery', status: delivery.status });
		}
		if (
			delivery.event.kind === 'decision' &&
			delivery.status === 'failed' &&
			delivery.retryable &&
			attempt < 3
		) {
			if (!(await restartDelivery(ctx, delivery, true)))
				await recordOutcome(ctx, delivery, { status: 'skipped' });
		} else if (
			delivery.event.kind === 'approval' &&
			delivery.status === 'uncertain' &&
			!delivery.retryable
		) {
			const retryAt = (delivery.completedAt ?? Date.now()) + UNCERTAIN_COOLDOWN;
			if (Date.now() >= retryAt) await ctx.db.patch('emailDeliveries', id, { retryable: true });
			else await scheduleRecovery(ctx, delivery, retryAt);
		}
		return null;
	}
});
/** Explicit retries reuse the event and snapshot, with a new guarded attempt. */
export async function restartDelivery(ctx: MutationCtx, delivery: Delivery, fromRecovery = false) {
	const explicitApprovalRetry =
		delivery.event.kind === 'approval' && delivery.status === 'uncertain' && delivery.retryable;
	if (
		delivery.event.kind === 'invitation' ||
		(delivery.status !== 'failed' && !explicitApprovalRetry) ||
		(await activeDelivery(ctx, delivery)) ||
		!(await eligibleContract(ctx, delivery))
	)
		return false;
	if (!fromRecovery) await cancelJob(ctx, delivery.recoveryJobId);
	const attempt = delivery.attempt + 1;
	const sendJobId = await ctx.scheduler.runAfter(0, internal.contractEmail.send, {
		id: delivery._id,
		attempt
	});
	await ctx.db.patch('emailDeliveries', delivery._id, {
		attempt,
		sendJobId,
		status: 'sending',
		dispatchStarted: false,
		retryable: false,
		error: undefined,
		messageId: undefined,
		rejected: undefined,
		recipientAccepted: undefined,
		completedAt: undefined
	});
	await scheduleRecovery(ctx, { ...delivery, attempt });
	return true;
}
export const retry = internalMutation({
	args: { id: v.id('emailDeliveries') },
	returns: v.boolean(),
	handler: async (ctx, { id }) => {
		const delivery = await ctx.db.get('emailDeliveries', id);
		// Decision uncertainty and partial acceptance must never be automatically resent.
		return delivery?.event.kind === 'decision' && delivery.status === 'failed'
			? restartDelivery(ctx, delivery)
			: false;
	}
});
export async function removeDelivery(ctx: MutationCtx, delivery: Delivery) {
	await cancelDelivery(ctx, delivery);
	await deleteSelections(ctx, delivery._id);
	await ctx.db.delete('emailDeliveries', delivery._id);
}
export const removeForContract = internalMutation({
	args: { id: v.id('savedContracts') },
	returns: v.null(),
	handler: async (ctx, { id }): Promise<null> => {
		const row = await ctx.db
			.query('emailDeliveries')
			.withIndex('by_contractId', (q) => q.eq('contractId', id))
			.first();
		if (row) {
			await removeDelivery(ctx, row);
			await ctx.scheduler.runAfter(0, internal.emailDeliveries.removeForContract, { id });
		} else {
			const rows = await ctx.db
				.query('reviewAttributions')
				.withIndex('by_contractId', (q) => q.eq('contractId', id))
				.take(32);
			for (const row of rows) await ctx.db.delete('reviewAttributions', row._id);
		}
		return null;
	}
});
