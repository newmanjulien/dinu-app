import { v, type Infer } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
	internalMutation,
	internalQuery,
	type MutationCtx,
	type QueryCtx
} from './_generated/server';
import { availableCompany, liveCompanyMember } from './auth';
import { CLEANUP_DISCOVERY_PAGE_SIZE } from './cleanup';
import { snapshotPage } from './emailSelectionChunks';
import {
	authorizeReviewDelivery,
	effectiveSnapshotEntry,
	latestFor as latestForFilter,
	requestCoverage as requestCoverageForFilter
} from './nativeEmail';
import { receiptChunkFingerprint } from './operationReceipts';
import { paginationOptsValidator } from 'convex/server';
import {
	emailAddress,
	emailAttempt,
	emailOutcome,
	emailRecipients,
	emailFilterFence,
	emailFilterManifest,
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
type NewDelivery = {
	companyId: Id<'company'>;
	event: Extract<EmailEvent, { kind: 'invitation' }>;
	inlineDeadline: number;
};

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
	if ('snapshot' in delivery && delivery.snapshot.state === 'staging') return false;
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
/** Inline invitation delivery keeps its existing attempt/recovery lifetime. */
export async function createDelivery(ctx: MutationCtx, data: NewDelivery) {
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
/** Caller has measured snapshot, request/root, receipt and both jobs before its first write. */
export async function activateSnapshotDelivery(
	ctx: MutationCtx,
	delivery: Extract<Delivery, { contractId: Id<'savedContracts'> }>
) {
	if (delivery.snapshot.state !== 'complete')
		throw new Error('Only a sealed snapshot can be activated.');
	const sendJobId = await ctx.scheduler.runAfter(0, internal.contractEmail.send, {
		id: delivery._id,
		attempt: delivery.attempt
	});
	const recoveryJobId = await ctx.scheduler.runAt(
		Date.now() + RECOVERY_INTERVAL,
		internal.emailDeliveries.recover,
		{ id: delivery._id, attempt: delivery.attempt }
	);
	await ctx.db.patch('emailDeliveries', delivery._id, {
		snapshot: delivery.snapshot,
		execution: { kind: 'scheduled', sendJobId, recoveryJobId }
	});
}
async function eligibleContract(ctx: QueryCtx, delivery: Delivery) {
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
	if (!('snapshot' in delivery)) return null;
	return authorizeReviewDelivery(ctx, delivery);
}
function fenceOf(context: NonNullable<Awaited<ReturnType<typeof authorizeReviewDelivery>>>) {
	return {
		stateRevision: context.contract.root.stateRevision,
		supportGeneration: context.index.supportIndexGeneration,
		storageGeneration: context.index.nativeStorageGeneration
	};
}
function sameFence(a: Infer<typeof emailFilterFence>, b: Infer<typeof emailFilterFence>) {
	return (
		a.stateRevision === b.stateRevision &&
		a.supportGeneration === b.supportGeneration &&
		a.storageGeneration === b.storageGeneration
	);
}
function pendingAttempt(delivery: Delivery | null, attempt: number) {
	return (
		delivery &&
		!delivery.disposal &&
		delivery.attempt === attempt &&
		delivery.state.kind === 'sending'
	);
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

/** Cheap owner/authorization gate. Snapshot bodies are only read through bounded pages. */
export const prepare = internalMutation({
	args: emailAttempt.fields,
	returns: v.union(
		v.object({
			delivery: schema.doc('emailDeliveries'),
			fence: v.union(emailFilterFence, v.null())
		}),
		v.null()
	),
	handler: async (ctx, args) => {
		const delivery = await ctx.db.get('emailDeliveries', args.id);
		if (
			!pendingAttempt(delivery, args.attempt) ||
			!delivery ||
			delivery.state.dispatch?.kind !== 'pending'
		)
			return null;
		const context = await eligibleContract(ctx, delivery);
		if (!context) return null;
		return { delivery, fence: 'contract' in context ? fenceOf(context) : null };
	}
});
/** One bounded immutable page and exact per-entry effective membership. The action
 * carries only this constant-size manifest; no full snapshot array crosses a function. */
export const filterPage = internalQuery({
	args: {
		...emailAttempt.fields,
		paginationOpts: paginationOptsValidator,
		manifest: emailFilterManifest
	},
	returns: v.union(
		v.object({ manifest: emailFilterManifest, continueCursor: v.string(), isDone: v.boolean() }),
		v.null()
	),
	handler: async (ctx, args) => {
		const delivery = await ctx.db.get('emailDeliveries', args.id);
		if (
			!pendingAttempt(delivery, args.attempt) ||
			!delivery ||
			!('snapshot' in delivery) ||
			delivery.state.dispatch?.kind !== 'pending'
		)
			return null;
		const context = await authorizeReviewDelivery(ctx, delivery);
		if (!context || !sameFence(args.manifest.fence, fenceOf(context))) return null;
		const page = await snapshotPage(ctx, delivery, {
			...args.paginationOpts,
			numItems: 1,
			maximumRowsRead: 1,
			maximumBytesRead: 256 * 1024
		});
		const next = { ...args.manifest, counts: { ...args.manifest.counts } };
		for (const row of page.page) {
			if (row.order !== next.order || row.previousHash !== next.hash)
				throw new Error('Email snapshot page is discontinuous.');
			for (const entry of row.entries) {
				const eligible = await effectiveSnapshotEntry(
					ctx,
					context.contract,
					context.index,
					entry,
					delivery.event.kind,
					delivery.snapshot.cutoff
				);
				next.filteredHash = receiptChunkFingerprint(
					JSON.stringify([
						next.filteredHash,
						entry.changeId,
						entry.decisionId,
						entry.pendingAdmissionRevision,
						eligible
					])
				);
				if (!eligible) continue;
				if (entry.status === 'pending') next.counts.pendingCount++;
				else {
					next.counts.reviewedCount++;
					if (entry.status === 'approved') next.counts.approvedCount++;
					else next.counts.rejectedCount++;
				}
			}
			next.order++;
			next.hash = row.hash;
			next.count += row.entries.length;
			next.bytes += row.bytes;
		}
		if (
			page.isDone &&
			(next.order !== delivery.snapshot.chunks ||
				next.hash !== delivery.snapshot.hash ||
				next.count !== delivery.snapshot.count ||
				next.bytes !== delivery.snapshot.bytes)
		)
			throw new Error('Email snapshot manifest is incomplete.');
		return { manifest: next, continueCursor: page.continueCursor, isDone: page.isDone };
	}
});
const sendGate = v.union(
	v.object({ status: v.literal('ready'), recipients: emailRecipients }),
	v.object({ status: v.literal('refilter') }),
	v.null()
);
async function validFilter(
	ctx: QueryCtx,
	delivery: Delivery,
	context: NonNullable<Awaited<ReturnType<typeof eligibleContract>>>,
	manifest?: Infer<typeof emailFilterManifest>
) {
	if (!('snapshot' in delivery)) return true;
	if (!('contract' in context) || !manifest || !sameFence(manifest.fence, fenceOf(context)))
		return false;
	const snapshot = delivery.snapshot;
	if (
		manifest.order !== snapshot.chunks ||
		manifest.count !== snapshot.count ||
		manifest.bytes !== snapshot.bytes ||
		manifest.hash !== snapshot.hash
	)
		return false;
	const count = manifest.counts.pendingCount + manifest.counts.reviewedCount;
	if (!count || manifest.counts.notRequiredCount !== 0) return false;
	// Exact committed summary closes filtered completeness under the same native fences.
	if (delivery.event.kind === 'decision')
		return count === snapshot.count && manifest.counts.pendingCount === 0;
	const latest = await latestForFilter(ctx, delivery.contractId, delivery.event.context);
	if (!latest) return false;
	const coverage = await requestCoverageForFilter(
		ctx,
		context.contract,
		delivery.event.context,
		latest,
		context.index
	);
	return (
		manifest.counts.pendingCount === coverage.coveredPendingCount &&
		manifest.counts.reviewedCount === 0
	);
}
export const claim = internalMutation({
	args: { ...emailAttempt.fields, manifest: v.optional(emailFilterManifest) },
	returns: sendGate,
	handler: async (ctx, args) => {
		const delivery = await ctx.db.get('emailDeliveries', args.id);
		if (
			!pendingAttempt(delivery, args.attempt) ||
			!delivery ||
			delivery.state.dispatch?.kind !== 'pending'
		)
			return null;
		const context = await eligibleContract(ctx, delivery);
		const to = context
			? await recipients(
					ctx,
					delivery,
					'contract' in context ? context.contract.root.creatorId : undefined
				)
			: null;
		if (!to) {
			await recordOutcome(ctx, delivery, { status: 'skipped' });
			await cancelJob(ctx, delivery.execution.recoveryJobId);
			return null;
		}
		if (!(await validFilter(ctx, delivery, context!, args.manifest)))
			return { status: 'refilter' as const };
		await ctx.db.patch('emailDeliveries', delivery._id, {
			filter: args.manifest,
			state: { kind: 'sending', dispatch: { kind: 'claimed', ...to } }
		});
		return { status: 'ready' as const, recipients: to };
	}
});
/** Exact manifest fences are checked in the same mutation granting the provider send lease. */
export const beginDispatch = internalMutation({
	args: { ...emailAttempt.fields, manifest: v.optional(emailFilterManifest) },
	returns: sendGate,
	handler: async (ctx, args) => {
		const delivery = await ctx.db.get('emailDeliveries', args.id);
		if (
			!pendingAttempt(delivery, args.attempt) ||
			!delivery ||
			delivery.state.dispatch?.kind !== 'claimed'
		)
			return null;
		const context = await eligibleContract(ctx, delivery);
		const to = context
			? await recipients(
					ctx,
					delivery,
					'contract' in context ? context.contract.root.creatorId : undefined
				)
			: null;
		if (!to) return null;
		if (
			JSON.stringify(delivery.filter) !== JSON.stringify(args.manifest) ||
			!(await validFilter(ctx, delivery, context!, args.manifest))
		) {
			await ctx.db.patch('emailDeliveries', delivery._id, {
				filter: undefined,
				state: { kind: 'sending', dispatch: { kind: 'pending' } }
			});
			return { status: 'refilter' as const };
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
		if (delivery && 'snapshot' in delivery && delivery.snapshot.state === 'staging') return null;
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
	if ('snapshot' in delivery && delivery.snapshot.state === 'staging') return false;
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
		filter: undefined,
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
