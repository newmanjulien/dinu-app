import { ConvexError, v, type Infer } from 'convex/values';
import { mutation } from './_generated/server';
import { contractReadiness, decisionAction } from '../lib/contract/changes';
import { isRepItem } from '../lib/playbook/model';
import { retractBuyerLinkConcession, syncBuyerLink } from './buyerLinks';
import { requireContractWork } from './contractPolicy';
import { deliveryStatusOf, stateOf } from './contracts';
import { patchContract, seller } from './contractState';
import { requestDeliveryStatus } from './contractValidators';
import { createContractDelivery, removeDelivery, restartDelivery } from './emailDeliveries';
import { emailAddress } from './emailValidators';
import { activity } from './hubspotRecords';
import { actionKey, actorOf, receipt, remember, validateOperationId } from './operationReceipts';
import { contractState } from './savedContractValidators';
import { snapshotReader } from './templates';

/** Admin approves or declines a selected concession requiring approval. */
export const decide = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('savedContracts'),
		itemId: v.id('playbookItems'),
		expectedOptionId: v.string(),
		expectedStateRevision: v.number(),
		action: decisionAction,
		operationId: v.string()
	},
	returns: contractState,
	handler: async (ctx, args) => {
		const { access, contract } = await seller(ctx, args);
		validateOperationId(args.operationId);
		if (access.membership.role !== 'admin')
			throw new ConvexError('Only company admins can review concessions.');

		const key = actionKey(access, 'decide', args.operationId);
		const inputs = JSON.stringify([
			args.id,
			args.itemId,
			args.expectedOptionId,
			args.expectedStateRevision,
			args.action
		]);
		const prior = await receipt(ctx, key, inputs);
		if (prior) {
			if (prior.companyId !== access.companyId || prior.contractId !== contract.root._id)
				throw new Error('Decision receipt ownership is invalid.');
			return JSON.parse(prior.result) as Infer<typeof contractState>;
		}

		await requireContractWork(ctx, contract);
		if (contract.root.stateRevision !== args.expectedStateRevision)
			throw new ConvexError('This contract changed. Reload before reviewing.');

		const index = contract.root.concessions.findIndex(
			(entry) => entry.itemId === args.itemId && entry.optionId === args.expectedOptionId
		);
		if (index < 0) throw new ConvexError('This concession changed. Reload before reviewing.');

		const current = contract.root.concessions[index];
		const nextStatus = args.action === 'approve' ? ('approved' as const) : ('rejected' as const);
		if (current.status === nextStatus)
			throw new ConvexError(
				nextStatus === 'approved'
					? 'This concession is already approved.'
					: 'This concession was already declined.'
			);

		const reader = await snapshotReader(ctx, contract.root);
		const itemIds = contract.root.concessions.map((c) => c.itemId);
		const items = await reader.readItemsByIds(itemIds);
		const itemsById = new Map(items.map((item) => [item._id, item]));
		const item = itemsById.get(args.itemId);
		if (!item || !isRepItem(item) || item.approvalPolicy.kind !== 'required')
			throw new ConvexError('This concession does not require approval.');
		const option = item.concessions.find((c) => c.id === args.expectedOptionId);
		if (!option) throw new ConvexError('This Playbook option is unavailable.');

		const now = Date.now();
		const savedAt = Math.max(now, contract.root.savedAt + 1);
		const priorDecidedAt =
			contract.root.review.completion?.kind === 'awaitingConfirmation'
				? contract.root.review.completion.decidedAt
				: 0;
		const decidedAt = Math.max(savedAt, priorDecidedAt + 1);
		const nextConcessions = contract.root.concessions.map((entry, i) =>
			i === index
				? {
						...entry,
						status: nextStatus,
						reviewedBy: access.profile._id,
						reviewedAt: now
					}
				: entry
		);

		const hasPending = nextConcessions.some((entry) => entry.status === 'pending');
		const hasRequired = nextConcessions.some((entry) => {
			const record = itemsById.get(entry.itemId);
			return record && isRepItem(record) && record.approvalPolicy.kind === 'required';
		});
		let retainedRequest = contract.root.review.request;
		if (!hasPending && retainedRequest) {
			const requestDelivery = await ctx.db.get('emailDeliveries', retainedRequest.deliveryId);
			if (requestDelivery?.state.kind !== 'sent') {
				if (requestDelivery) await removeDelivery(ctx, requestDelivery);
				retainedRequest = undefined;
			}
		}
		const nextReview =
			!hasPending && hasRequired
				? {
						generation: contract.root.review.generation,
						...(retainedRequest ? { request: retainedRequest } : {}),
						completion: {
							generation: contract.root.review.generation,
							kind: 'awaitingConfirmation' as const,
							reviewerId: access.profile._id,
							decidedAt
						}
					}
				: {
						generation: contract.root.review.generation,
						...(retainedRequest ? { request: retainedRequest } : {})
					};

		if (contract.root.review.completion?.kind === 'queued') {
			const previousDelivery = await ctx.db.get(
				'emailDeliveries',
				contract.root.review.completion.deliveryId
			);
			if (previousDelivery) await removeDelivery(ctx, previousDelivery);
		}

		await activity(
			ctx,
			contract,
			actorOf(access.profile),
			key,
			args.action === 'approve' ? 'approved' : 'declined',
			JSON.stringify({
				itemId: args.itemId,
				contentRevision: item.contentRevision,
				concessionId: args.expectedOptionId,
				description: option.description
			}),
			now
		);

		const updated = await patchContract(ctx, contract, {
			concessions: nextConcessions,
			review: nextReview,
			savedAt,
			stateRevision: contract.root.stateRevision + 1,
			lastOperation: { id: args.operationId, callerId: access.profile._id }
		});

		if (contractReadiness(nextConcessions).ready) {
			await syncBuyerLink(ctx, updated.root, { itemsById });
		} else if (current.status === 'approved' && nextStatus === 'rejected') {
			await retractBuyerLinkConcession(ctx, updated.root, args.itemId, { itemsById });
		}

		const result = stateOf(updated);
		await remember(ctx, access.companyId, key, inputs, JSON.stringify(result), contract.root._id);
		return result;
	}
});

/** Submit pending concessions for admin approval via Loops email. */
export const request = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('savedContracts'),
		expectedGeneration: v.number(),
		operationId: v.string()
	},
	returns: requestDeliveryStatus,
	handler: async (ctx, args) => {
		const { access, contract } = await seller(ctx, args);
		validateOperationId(args.operationId);

		const key = actionKey(access, 'approval-request', args.operationId);
		const inputs = JSON.stringify([args.id, args.expectedGeneration]);
		const prior = await receipt(ctx, key, inputs);
		if (prior) {
			if (prior.companyId !== access.companyId || prior.contractId !== contract.root._id)
				throw new Error('Approval request receipt ownership is invalid.');
			return JSON.parse(prior.result) as Infer<typeof requestDeliveryStatus>;
		}

		await requireContractWork(ctx, contract);
		if (contract.root.review.generation !== args.expectedGeneration)
			throw new ConvexError('This contract changed. Review the current concessions and try again.');

		const { company } = access;
		if (!company.approvalEmail)
			throw new ConvexError(
				'Set an approval email in workspace settings before requesting approval.'
			);
		emailAddress(company.approvalEmail);

		const existing = contract.root.review.request;
		const alreadyLoggedRequest = Boolean(
			existing && existing.generation === contract.root.review.generation
		);
		let retryDelivery: NonNullable<
			Awaited<ReturnType<typeof ctx.db.get<'emailDeliveries'>>>
		> | null = null;
		if (existing && existing.generation === contract.root.review.generation) {
			const delivery = await ctx.db.get('emailDeliveries', existing.deliveryId);
			const currentStatus = deliveryStatusOf(existing, delivery);
			if (currentStatus) {
				if (currentStatus.status === 'sending' || currentStatus.status === 'sent') {
					await remember(
						ctx,
						access.companyId,
						key,
						inputs,
						JSON.stringify(currentStatus),
						contract.root._id
					);
					return currentStatus;
				}
				if (currentStatus.status === 'uncertain' && !currentStatus.retryEligible) {
					throw new ConvexError(
						currentStatus.error ??
							'Email delivery could not be confirmed. Wait before requesting approval again.'
					);
				}
				if (delivery && currentStatus.retryEligible) {
					retryDelivery = delivery;
				}
			}
			if (!retryDelivery && delivery) await removeDelivery(ctx, delivery);
		}

		const reader = await snapshotReader(ctx, contract.root);
		const items = await reader.readItemsByIds(contract.root.concessions.map((c) => c.itemId));
		const itemsById = new Map(items.map((item) => [item._id, item]));

		let pendingCount = 0;
		let reviewedCount = 0;
		let notRequiredCount = 0;
		for (const entry of contract.root.concessions) {
			const item = itemsById.get(entry.itemId);
			if (!item || !isRepItem(item)) continue;
			if (item.approvalPolicy.kind === 'none') notRequiredCount++;
			else if (entry.status === 'pending') pendingCount++;
			else reviewedCount++;
		}
		if (pendingCount === 0) throw new ConvexError('There are no concessions waiting for approval.');

		const approvalEvent = {
			kind: 'approval' as const,
			contractId: contract.root._id,
			generation: contract.root.review.generation,
			title: contract.root.title,
			pendingCount,
			reviewedCount,
			notRequiredCount
		};
		if (retryDelivery && existing) {
			const restarted = await restartDelivery(ctx, retryDelivery, false, approvalEvent);
			const refreshed = deliveryStatusOf(
				existing,
				await ctx.db.get('emailDeliveries', retryDelivery._id)
			);
			if (restarted && refreshed) {
				await remember(
					ctx,
					access.companyId,
					key,
					inputs,
					JSON.stringify(refreshed),
					contract.root._id
				);
				return refreshed;
			}
			if (refreshed && (refreshed.status === 'sending' || refreshed.status === 'sent')) {
				await remember(
					ctx,
					access.companyId,
					key,
					inputs,
					JSON.stringify(refreshed),
					contract.root._id
				);
				return refreshed;
			}
			throw new ConvexError('We couldn’t retry the approval email. Refresh and try again.');
		}

		const now = Date.now();
		if (!alreadyLoggedRequest) {
			await activity(
				ctx,
				contract,
				actorOf(access.profile),
				key,
				'requested',
				JSON.stringify({ count: pendingCount, pendingCount, reviewedCount, notRequiredCount }),
				now
			);
		}

		const deliveryId = await createContractDelivery(ctx, {
			companyId: access.companyId,
			contractId: contract.root._id,
			event: approvalEvent
		});

		const requestRecord = {
			generation: contract.root.review.generation,
			deliveryId,
			requesterId: access.profile._id,
			requestedAt: now
		};
		await patchContract(ctx, contract, {
			review: {
				...contract.root.review,
				request: requestRecord
			}
		});

		const status: Infer<typeof requestDeliveryStatus> = {
			generation: requestRecord.generation,
			requestedAt: now,
			status: 'sending',
			retryEligible: false
		};
		await remember(ctx, access.companyId, key, inputs, JSON.stringify(status), contract.root._id);
		return status;
	}
});

/** Admin confirms review completion and notifies the contract creator via Loops email. */
export const complete = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('savedContracts'),
		expectedGeneration: v.number(),
		expectedDecidedAt: v.number(),
		operationId: v.string()
	},
	returns: v.object({ status: v.union(v.literal('queued'), v.literal('skipped')) }),
	handler: async (ctx, args) => {
		const { access, contract } = await seller(ctx, args);
		validateOperationId(args.operationId);
		if (access.membership.role !== 'admin')
			throw new ConvexError('Only company admins can complete reviews.');

		const key = actionKey(access, 'review-completion', args.operationId);
		const inputs = JSON.stringify([args.id, args.expectedGeneration, args.expectedDecidedAt]);
		const prior = await receipt(ctx, key, inputs);
		if (prior) {
			if (prior.companyId !== access.companyId || prior.contractId !== contract.root._id)
				throw new Error('Completion receipt ownership is invalid.');
			return JSON.parse(prior.result) as { status: 'queued' | 'skipped' };
		}

		await requireContractWork(ctx, contract);
		const completion = contract.root.review.completion;
		if (
			contract.root.review.generation !== args.expectedGeneration ||
			!completion ||
			completion.generation !== args.expectedGeneration
		) {
			const skipped = { status: 'skipped' as const };
			await remember(
				ctx,
				access.companyId,
				key,
				inputs,
				JSON.stringify(skipped),
				contract.root._id
			);
			return skipped;
		}
		if (completion.kind === 'queued') {
			const queued = { status: 'queued' as const };
			await remember(ctx, access.companyId, key, inputs, JSON.stringify(queued), contract.root._id);
			return queued;
		}
		if (
			completion.decidedAt !== args.expectedDecidedAt ||
			contract.root.concessions.some((entry) => entry.status === 'pending')
		) {
			const skipped = { status: 'skipped' as const };
			await remember(
				ctx,
				access.companyId,
				key,
				inputs,
				JSON.stringify(skipped),
				contract.root._id
			);
			return skipped;
		}

		const reader = await snapshotReader(ctx, contract.root);
		const items = await reader.readItemsByIds(contract.root.concessions.map((c) => c.itemId));
		const itemsById = new Map(items.map((item) => [item._id, item]));

		let approvedCount = 0;
		let rejectedCount = 0;
		for (const entry of contract.root.concessions) {
			const item = itemsById.get(entry.itemId);
			if (!item || !isRepItem(item) || item.approvalPolicy.kind !== 'required') continue;
			if (entry.status === 'approved') approvedCount++;
			else if (entry.status === 'rejected') rejectedCount++;
		}

		const deliveryId = await createContractDelivery(ctx, {
			companyId: access.companyId,
			contractId: contract.root._id,
			event: {
				kind: 'decision',
				contractId: contract.root._id,
				generation: contract.root.review.generation,
				title: contract.root.title,
				reviewerId: completion.reviewerId,
				approvedCount,
				rejectedCount
			}
		});

		await patchContract(ctx, contract, {
			review: {
				...contract.root.review,
				completion: {
					generation: contract.root.review.generation,
					kind: 'queued',
					deliveryId
				}
			}
		});

		const result = { status: 'queued' as const };
		await remember(ctx, access.companyId, key, inputs, JSON.stringify(result), contract.root._id);
		return result;
	}
});
