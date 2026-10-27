import { requireMembership, accessibleContract, scopedOperation } from './auth';
import { approvalCoversPending } from '../lib/contract/approval';
import { ConvexError, v, type Infer } from 'convex/values';
import { mutation, query, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { approvalRequest, reviewDecision } from './contractValidators';
import { snapshotReader } from './templates';
import { queueCompletedReview } from './decisionNotifications';
import { attribution, updateAttributions } from './reviewAttributions';
import { emailAddress, type EmailSelection } from './emailValidators';
import {
	activeDelivery,
	createDelivery,
	removeDelivery,
	restartDelivery,
	UNCERTAIN_COOLDOWN
} from './emailDeliveries';
import { selectionsFor } from './emailSnapshots';

type Request = Doc<'approvalRequests'>;
function latestFor(ctx: QueryCtx, id: Id<'savedContracts'>) {
	return ctx.db
		.query('approvalRequests')
		.withIndex('by_contractId', (q) => q.eq('contractId', id))
		.unique();
}
async function requestForClient(
	ctx: QueryCtx,
	request: Request
): Promise<Infer<typeof approvalRequest>> {
	if (!('deliveryId' in request)) {
		const job = await ctx.db.system.get('_scheduled_functions', request.sendJobId);
		return {
			id: request.id,
			companyName: request.companyName,
			selectedConcessions: request.selectedConcessions,
			status: request.status,
			requestedAt: request.requestedAt,
			completedAt: request.completedAt,
			error: request.error,
			retryAt: request.retryAt,
			retryEligible:
				(request.status === 'failed' || request.retryEligible) &&
				job?.state.kind !== 'pending' &&
				job?.state.kind !== 'inProgress'
		};
	}
	const delivery = await ctx.db.get('emailDeliveries', request.deliveryId);
	const status =
		delivery?.status === 'partial' || delivery?.status === 'skipped' || !delivery
			? 'failed'
			: delivery.status;
	const selectedConcessions = (await selectionsFor(ctx, request.deliveryId)).map((s) => {
		if (s.concessionPosition === undefined)
			throw new Error('Approval snapshot position is missing.');
		return {
			itemId: s.itemId,
			concessionPosition: s.concessionPosition,
			lifecycle: s.lifecycle,
			reviewStatus: s.reviewStatus
		};
	});
	return {
		id: request.id,
		companyName: request.companyName,
		selectedConcessions,
		requestedAt: request.requestedAt,
		status,
		completedAt: delivery?.completedAt,
		error: delivery?.error,
		retryAt:
			status === 'uncertain' && delivery?.completedAt !== undefined
				? delivery.completedAt + UNCERTAIN_COOLDOWN
				: undefined,
		retryEligible: Boolean(
			delivery &&
			(status === 'failed' || delivery.retryable) &&
			!(await activeDelivery(ctx, delivery))
		)
	};
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
		if (contract.revision !== expectedRevision)
			throw new ConvexError(
				'This contract changed. Wait for the latest saved version before requesting approval.'
			);
		const previous = await latestFor(ctx, id);
		const previousView = previous ? await requestForClient(ctx, previous) : null;
		if (
			previousView &&
			(previousView.status === 'sending' ||
				(previousView.status === 'uncertain' && !previousView.retryEligible) ||
				(previousView.status === 'failed' && !previousView.retryEligible))
		)
			throw new ConvexError(
				'The current approval request is still resolving. Please wait before trying again.'
			);
		const configured = access.company.approvalEmail;
		if (!configured)
			throw new ConvexError('Ask your company admin to configure an approval email in Settings.');
		const recipientEmail = emailAddress(configured);
		const reader = await snapshotReader(ctx, contract);
		const items = await reader.selectedItems(contract.selectedConcessions);
		const selections: EmailSelection[] = items.map((item) => {
			const concessionId = contract.selectedConcessions[item._id];
			const review = contract.reviews[item._id];
			const required = Boolean(item.instructions?.changesNeedApproval?.trim());
			if (required && (!review || review.concessionId !== concessionId))
				throw new ConvexError('This concession is missing review metadata.');
			return {
				itemId: item._id,
				concessionId,
				concessionPosition: item.concessions.findIndex((c) => c.id === concessionId),
				...(required ? { lifecycle: review!.lifecycle, reviewStatus: review!.status } : {})
			};
		});
		const pending = selections.flatMap((s) =>
			s.reviewStatus === 'pending' &&
			s.lifecycle !== undefined &&
			s.concessionPosition !== undefined
				? [{ ...s, lifecycle: s.lifecycle, concessionPosition: s.concessionPosition }]
				: []
		);
		if (!pending.length) throw new ConvexError('There are no concessions waiting for approval.');
		if (!contract.companyName.trim()) throw new ConvexError('Enter a buyer company name.');
		if (
			previousView?.status === 'sent' &&
			previous?.recipientEmail.trim().toLowerCase() === recipientEmail &&
			approvalCoversPending(pending, previousView.selectedConcessions)
		)
			return previousView;
		if (previous && 'deliveryId' in previous) {
			const old = await ctx.db.get('emailDeliveries', previous.deliveryId);
			if (
				old &&
				previous.recipientEmail === recipientEmail &&
				previousView &&
				approvalCoversPending(pending, previousView.selectedConcessions) &&
				(await restartDelivery(ctx, old))
			)
				return requestForClient(ctx, previous);
			if (old) await removeDelivery(ctx, old);
		}
		const requestedAt = Date.now();
		const requestId = `${requestedAt}-${Math.random().toString(36).slice(2)}`;
		const deliveryId = await createDelivery(
			ctx,
			{
				companyId: access.companyId,
				contractId: id,
				recipientEmail,
				event: {
					kind: 'approval',
					contractId: id,
					requestId,
					companyName: contract.companyName,
					templateVersionId: contract.templateVersionId
				}
			},
			selections
		);
		const next = {
			id: requestId,
			recipientEmail,
			companyId: access.companyId,
			contractId: id,
			companyName: contract.companyName,
			requestedAt,
			deliveryId
		};
		const requestRecordId = previous ? previous._id : await ctx.db.insert('approvalRequests', next);
		if (previous) await ctx.db.replace('approvalRequests', previous._id, next);
		return requestForClient(ctx, { ...next, _id: requestRecordId, _creationTime: requestedAt });
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
	returns: v.object({ reviewCompleted: v.boolean() }),
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
			return { reviewCompleted: receipt.reviewCompleted ?? false };
		}
		if (contract.selectedConcessions[args.itemId] !== args.concessionId)
			throw new ConvexError('This concession changed. Review its current version.');
		const reader = await snapshotReader(ctx, contract);
		const [item] = await reader.selectedItems({ [args.itemId]: args.concessionId });
		if (!item?.instructions?.changesNeedApproval?.trim())
			throw new ConvexError('This concession does not require approval.');
		const review = contract.reviews[args.itemId];
		if (!review || review.concessionId !== args.concessionId)
			throw new ConvexError('This concession is missing review metadata.');
		const lifecycle = review.lifecycle;
		if (lifecycle !== args.lifecycle)
			throw new ConvexError('This concession was replaced. Review its current version.');
		const previousStatus = review.status;
		const changed = previousStatus !== args.status;
		let reviewCompleted = false;
		if (changed) {
			const reviews = {
				...contract.reviews,
				[args.itemId]: { concessionId: args.concessionId, lifecycle, status: args.status }
			};
			const reviewGeneration = (contract.reviewGeneration ?? 0) + 1;
			await updateAttributions(ctx, contract, reviews, [
				attribution(args.itemId, args.concessionId, lifecycle, access)
			]);
			await ctx.db.patch('savedContracts', args.id, { reviews, reviewGeneration });
			const notificationQueued = await queueCompletedReview(ctx, {
				...contract,
				reviews,
				reviewGeneration
			});
			reviewCompleted = previousStatus === 'pending' && notificationQueued;
		}
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
			changed,
			reviewCompleted
		});
		return { reviewCompleted };
	}
});
