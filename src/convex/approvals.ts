import { requireMembership, accessibleContract, scopedOperation, availableCompany } from './auth';
import {
	approvalCoversPending,
	legacyLifecycle,
	reviewStatus as currentReviewStatus
} from '../lib/contract/approval';
import { ConvexError, v, type Infer } from 'convex/values';
import { internal } from './_generated/api';
import {
	internalMutation,
	internalQuery,
	mutation,
	query,
	type MutationCtx,
	type QueryCtx
} from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import {
	approvalRequest,
	approvalSelection,
	reviewStatus,
	reviewDecision
} from './contractValidators';
import { snapshotReader, readVersionItem } from './templates';

const RECOVERY_INTERVAL = 60_000;
const UNCERTAIN_COOLDOWN = 10 * 60_000;
const requestArgs = { id: v.id('savedContracts'), requestId: v.string() };
type Request = Doc<'approvalRequests'>;

function latestFor(ctx: QueryCtx, id: Id<'savedContracts'>) {
	return ctx.db
		.query('approvalRequests')
		.withIndex('by_contractId', (q) => q.eq('contractId', id))
		.unique();
}

function publicRequest(request: Infer<typeof approvalRequest>): Infer<typeof approvalRequest> {
	return {
		id: request.id,
		companyName: request.companyName,
		selectedConcessions: request.selectedConcessions,
		status: request.status,
		requestedAt: request.requestedAt,
		retryEligible: request.retryEligible,
		completedAt: request.completedAt,
		error: request.error,
		retryAt: request.retryAt
	};
}

async function jobActive(ctx: QueryCtx, request: Request) {
	const job = await ctx.db.system.get('_scheduled_functions', request.sendJobId);
	return job?.state.kind === 'pending' || job?.state.kind === 'inProgress';
}

async function requestForClient(ctx: QueryCtx, request: Request) {
	// The job can finish between recovery polls. React to its state so a confirmed
	// failure becomes retryable immediately, while an active action still blocks it.
	const retryEligible =
		(request.status === 'failed' || request.retryEligible) && !(await jobActive(ctx, request));
	return publicRequest({ ...request, retryEligible });
}

export const latest = query({
	args: { membershipId: v.id('memberships'), id: v.id('savedContracts') },
	returns: v.union(approvalRequest, v.null()),
	handler: async (ctx, { id, membershipId }) => {
		const access = await requireMembership(ctx, membershipId);
		if (!accessibleContract(await ctx.db.get('savedContracts', id), access)) return null;
		const request = await latestFor(ctx, id);
		return request ? requestForClient(ctx, request) : null;
	}
});

export const request = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('savedContracts'),
		expectedRevision: v.number()
	},
	returns: approvalRequest,
	handler: async (
		ctx,
		{ id, membershipId, expectedRevision }
	): Promise<Infer<typeof approvalRequest>> => {
		const access = await requireMembership(ctx, membershipId);
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
			throw new ConvexError('Invalid contract revision.');
		const contract = accessibleContract(await ctx.db.get('savedContracts', id), access);
		if (!contract) throw new ConvexError('This contract was deleted.');
		if ((contract.revision ?? 0) !== expectedRevision)
			throw new ConvexError(
				'This contract changed. Wait for the latest saved version before requesting approval.'
			);
		const previous = await latestFor(ctx, id);
		// Unresolved delivery blocks the entire contract, even if selections changed.
		const activeJob = previous ? await jobActive(ctx, previous) : false;
		if (
			previous &&
			(previous.status === 'sending' ||
				(previous.status === 'uncertain' && !previous.retryEligible) ||
				activeJob)
		)
			return publicRequest({
				...previous,
				retryEligible: (previous.status === 'failed' || previous.retryEligible) && !activeJob
			});
		const reader = await snapshotReader(ctx, contract);
		const items = await reader.selectedItems(contract.selectedConcessions);
		const selectedConcessions = items.map((item) => {
			const concessionId = contract.selectedConcessions[item._id];
			const review = contract.reviews?.[item._id];
			const lifecycle =
				review?.concessionId === concessionId
					? review.lifecycle
					: legacyLifecycle(item._id, concessionId);
			return {
				itemId: item._id,
				...(item.instructions?.changesNeedApproval?.trim()
					? {
							lifecycle,
							reviewStatus: currentReviewStatus(contract, item._id, concessionId, lifecycle)
						}
					: {}),
				concessionPosition: item.concessions.findIndex((c) => c.id === concessionId)
			};
		});
		const pending = selectedConcessions.flatMap((s) =>
			s.reviewStatus === 'pending' && s.lifecycle !== undefined
				? [{ ...s, concessionId: contract.selectedConcessions[s.itemId], lifecycle: s.lifecycle }]
				: []
		);
		if (!pending.length) throw new ConvexError('There are no concessions waiting for approval.');
		if (!contract.companyName.trim()) throw new ConvexError('Enter a buyer company name.');
		if (previous?.status === 'sent' && approvalCoversPending(pending, previous.selectedConcessions))
			return requestForClient(ctx, previous);

		const recipientEmail = access.company.approvalEmail;
		if (!recipientEmail)
			throw new ConvexError('Ask your company admin to configure an approval email in Settings.');
		const requestedAt = Date.now();
		const requestId = `${requestedAt}-${Math.random().toString(36).slice(2)}`;
		const args = { id, requestId };
		const sendJobId = await ctx.scheduler.runAfter(0, internal.approvalEmail.send, args);
		await ctx.scheduler.runAfter(RECOVERY_INTERVAL, internal.approvals.recover, args);
		const next = {
			id: requestId,
			recipientEmail,
			companyId: access.companyId,
			contractId: id,
			companyName: contract.companyName,
			selectedConcessions,
			status: 'sending' as const,
			requestedAt,
			sendJobId,
			dispatchStarted: false,
			retryEligible: false
		};
		if (previous) await ctx.db.replace('approvalRequests', previous._id, next);
		else await ctx.db.insert('approvalRequests', next);
		return publicRequest(next);
	}
});

export const forSend = internalQuery({
	args: requestArgs,
	returns: v.union(
		v.object({
			companyName: v.string(),
			selectedConcessions: v.array(approvalSelection),
			templateVersionId: v.id('templateVersions'),
			recipientEmail: v.string()
		}),
		v.null()
	),
	handler: async (ctx, { id, requestId }) => {
		const request = await latestFor(ctx, id);
		if (request?.id !== requestId || request.status !== 'sending' || request.dispatchStarted)
			return null;
		const contract = await ctx.db.get('savedContracts', id);
		if (!contract || contract.companyId !== request.companyId) return null;
		if (!(await availableCompany(ctx, request.companyId))) return null;
		await snapshotReader(ctx, contract);
		return {
			companyName: request.companyName,
			selectedConcessions: request.selectedConcessions,
			templateVersionId: contract.templateVersionId,
			recipientEmail: request.recipientEmail
		};
	}
});

export const descriptions = internalQuery({
	args: {
		templateVersionId: v.id('templateVersions'),
		selectedConcessions: v.array(approvalSelection)
	},
	returns: v.array(
		v.object({
			description: v.string(),
			requiresApproval: v.boolean(),
			reviewStatus: v.optional(reviewStatus)
		})
	),
	handler: async (ctx, { templateVersionId, selectedConcessions }) => {
		if (selectedConcessions.length > 4)
			throw new ConvexError('Too many descriptions in one batch.');
		// forSend validates the immutable parent once. startDispatch rechecks the active
		// request after all batches, so these reads need only the selected children.
		return Promise.all(
			selectedConcessions.map(async (selection) => {
				const item = await readVersionItem(ctx, templateVersionId, selection.itemId);
				const concession = item?.concessions[selection.concessionPosition];
				if (!item || !concession) throw new ConvexError('This contract snapshot is incomplete.');
				return {
					description: concession.description,
					reviewStatus: selection.reviewStatus,
					requiresApproval: Boolean(item.instructions?.changesNeedApproval?.trim())
				};
			})
		);
	}
});

export const startDispatch = internalMutation({
	args: requestArgs,
	returns: v.boolean(),
	handler: async (ctx, { id, requestId }) => {
		const request = await latestFor(ctx, id);
		if (request?.id !== requestId || request.status !== 'sending' || request.dispatchStarted)
			return false;
		const contract = await ctx.db.get('savedContracts', id);
		if (!contract?.companyId || contract.companyId !== request.companyId) return false;
		if (!(await availableCompany(ctx, request.companyId))) return false;
		await ctx.db.patch('approvalRequests', request._id, { dispatchStarted: true });
		return true;
	}
});

async function recordOutcome(
	ctx: MutationCtx,
	request: Request,
	status: 'sent' | 'failed' | 'uncertain',
	error?: string,
	messageId?: string
) {
	const completedAt = Date.now();
	const retryAt = status === 'uncertain' ? completedAt + UNCERTAIN_COOLDOWN : undefined;
	await ctx.db.patch('approvalRequests', request._id, {
		status,
		completedAt,
		error,
		messageId,
		retryAt,
		retryEligible: false
	});
	return retryAt;
}

export const complete = internalMutation({
	args: {
		...requestArgs,
		status: v.union(v.literal('sent'), v.literal('failed'), v.literal('uncertain')),
		error: v.optional(v.string()),
		messageId: v.optional(v.string())
	},
	returns: v.null(),
	handler: async (ctx, { id, requestId, status, error, messageId }) => {
		const request = await latestFor(ctx, id);
		if (
			request?.id !== requestId ||
			(request.status !== 'sending' && request.status !== 'uncertain')
		)
			return null;
		// Late acceptance may resolve uncertainty, but duplicate persistence must not
		// restart its cooldown or replace a recorded result with a different failure.
		if (request.status === 'uncertain' && status !== 'sent') return null;
		await recordOutcome(ctx, request, status, error, messageId);
		return null;
	}
});

export const recover = internalMutation({
	args: requestArgs,
	returns: v.null(),
	handler: async (ctx, { id, requestId }) => {
		const request = await latestFor(ctx, id);
		if (
			request?.id !== requestId ||
			request.status === 'sent' ||
			request.status === 'failed' ||
			request.retryEligible
		)
			return null;
		if (await jobActive(ctx, request)) {
			await ctx.scheduler.runAfter(RECOVERY_INTERVAL, internal.approvals.recover, {
				id,
				requestId
			});
			return null;
		}
		let retryAt = request.retryAt;
		if (request.status === 'sending') {
			const status = request.dispatchStarted ? 'uncertain' : 'failed';
			console.warn('approval_delivery', { requestId, stage: 'recovery', status });
			retryAt = await recordOutcome(
				ctx,
				request,
				status,
				request.dispatchStarted
					? 'Gmail delivery could not be confirmed. Wait 10 minutes before retrying; another request may deliver a duplicate email.'
					: 'The approval email stopped before Gmail dispatch. You can retry the request.'
			);
		}
		// This chain owns the cooldown whether the action or recovery recorded it.
		// The original send job is inactive before explicit retry is enabled.
		if (retryAt !== undefined && Date.now() >= retryAt) {
			await ctx.db.patch('approvalRequests', request._id, { retryEligible: true });
		} else if (retryAt !== undefined) {
			await ctx.scheduler.runAt(retryAt, internal.approvals.recover, { id, requestId });
		}
		return null;
	}
});

/** An operation receipt prevents an ambiguous retry from overwriting a later decision. */
export const decide = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('savedContracts'),
		itemId: v.id('playbookItems'),
		concessionId: v.string(),
		lifecycle: v.string(),
		status: reviewDecision,
		operationId: v.string()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		if (access.role !== 'admin')
			throw new ConvexError('Only company admins can review concessions.');
		if (!args.operationId.trim() || args.operationId.length > 200)
			throw new ConvexError('Invalid review operation.');
		const contract = accessibleContract(await ctx.db.get('savedContracts', args.id), access);
		if (!contract) throw new ConvexError('This contract was deleted.');
		const operationId = scopedOperation(access, JSON.stringify(['review', args.operationId]));
		const receipt = await ctx.db
			.query('concessionDecisions')
			.withIndex('by_contractId_and_operationId', (q) =>
				q.eq('contractId', args.id).eq('operationId', operationId)
			)
			.unique();
		if (receipt) {
			if (
				receipt.itemId !== args.itemId ||
				receipt.concessionId !== args.concessionId ||
				receipt.lifecycle !== args.lifecycle ||
				receipt.status !== args.status
			)
				throw new ConvexError('This review operation was already used.');
			return null;
		}
		if (contract.selectedConcessions[args.itemId] !== args.concessionId)
			throw new ConvexError('This concession changed. Review its current version.');
		const reader = await snapshotReader(ctx, contract);
		const [item] = await reader.selectedItems({ [args.itemId]: args.concessionId });
		if (!item?.instructions?.changesNeedApproval?.trim())
			throw new ConvexError('This concession does not require approval.');
		const lifecycle =
			contract.reviews?.[args.itemId]?.lifecycle ?? legacyLifecycle(args.itemId, args.concessionId);
		if (lifecycle !== args.lifecycle)
			throw new ConvexError('This concession was replaced. Review its current version.');
		const previousStatus = currentReviewStatus(contract, args.itemId, args.concessionId, lifecycle);
		const changed = previousStatus !== args.status;
		await ctx.db.insert('concessionDecisions', {
			companyId: access.companyId,
			contractId: args.id,
			itemId: args.itemId,
			concessionId: args.concessionId,
			lifecycle,
			adminId: access._id,
			adminName: access.name,
			adminEmail: access.email,
			operationId,
			previousStatus,
			status: args.status,
			decidedAt: Date.now(),
			changed
		});
		if (changed)
			await ctx.db.patch('savedContracts', args.id, {
				reviews: {
					...contract.reviews,
					[args.itemId]: { concessionId: args.concessionId, lifecycle, status: args.status }
				}
			});
		return null;
	}
});
