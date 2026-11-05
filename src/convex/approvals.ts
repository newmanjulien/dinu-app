import { requireMembership, accessibleContract, scopedOperation } from './auth';
import { approvalCoversPending } from '../lib/contract/approval';
import { ConvexError, v, type Infer } from 'convex/values';
import { mutation, query, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { approvalRequest, reviewDecision } from './contractValidators';
import { snapshotReader } from './templates';
import { recordDecision, completedReview } from './reviews';
import { writeDirectory } from './contractDirectory';
import { emailAddress, type EmailSelection } from './emailValidators';
import { activeJob, createDelivery, restartDelivery, UNCERTAIN_COOLDOWN } from './emailDeliveries';
import { removeDelivery } from './emailDisposal';
import { selectionsFor } from './emailSnapshots';

type Request = Doc<'approvalRequests'>;
function latestFor(ctx: QueryCtx, id: Id<'savedContracts'>) {
	return ctx.db
		.query('approvalRequests')
		.withIndex('by_contractId', (q) => q.eq('contractId', id))
		.unique();
}
function selectedForClient(selections: EmailSelection[]) {
	return selections.map((s) => {
		if (s.concessionPosition === undefined)
			throw new Error('Approval snapshot position is missing.');
		return {
			itemId: s.itemId,
			concessionPosition: s.concessionPosition,
			lifecycle: s.lifecycle,
			reviewStatus: s.reviewStatus
		};
	});
}
async function readRequest(ctx: QueryCtx, request: Request) {
	const delivery = await ctx.db.get('emailDeliveries', request.deliveryId);
	if (delivery && delivery.execution.kind !== 'scheduled')
		throw new Error('Approval delivery execution is invalid.');
	const state = delivery?.state;
	const status = state?.kind === 'skipped' || !state ? 'failed' : state.kind;
	const selectedConcessions = selectedForClient(await selectionsFor(ctx, request.deliveryId));
	const view: Infer<typeof approvalRequest> = {
		id: request.id,
		companyName: request.companyName,
		selectedConcessions,
		requestedAt: request.requestedAt,
		status,
		completedAt: state?.kind !== 'sending' ? state?.completedAt : undefined,
		error: state?.kind !== 'sending' ? state?.error : undefined,
		retryAt: state?.kind === 'uncertain' ? state.completedAt + UNCERTAIN_COOLDOWN : undefined,
		retryEligible: Boolean(
			delivery?.execution.kind === 'scheduled' &&
			(status === 'failed' || (state?.kind === 'uncertain' && state.retryEligible)) &&
			!(await activeJob(ctx, delivery.execution.sendJobId))
		)
	};
	return { delivery, view };
}
export const latest = query({
	args: { membershipId: v.id('memberships'), id: v.id('savedContracts') },
	returns: v.union(approvalRequest, v.null()),
	handler: async (ctx, { id, membershipId }) => {
		const access = await requireMembership(ctx, membershipId);
		if (!accessibleContract(await ctx.db.get('savedContracts', id), access)) return null;
		const request = await latestFor(ctx, id);
		return request ? (await readRequest(ctx, request)).view : null;
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
		const previousContext = previous ? await readRequest(ctx, previous) : null;
		const previousView = previousContext?.view;
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
		if (previous) {
			const old = previousContext?.delivery;
			if (
				old &&
				previous.recipientEmail === recipientEmail &&
				previousView &&
				approvalCoversPending(pending, previousView.selectedConcessions) &&
				(await restartDelivery(ctx, old))
			)
				return {
					...previousView,
					status: 'sending',
					completedAt: undefined,
					error: undefined,
					retryAt: undefined,
					retryEligible: false
				};
			if (old) await removeDelivery(ctx, old);
		}
		const requestedAt = Date.now();
		const requestId = `${requestedAt}-${Math.random().toString(36).slice(2)}`;
		const deliveryId = await createDelivery(
			ctx,
			{
				companyId: access.companyId,
				event: {
					kind: 'approval',
					contractId: id,
					requestId,
					companyName: contract.companyName,
					templateVersionId: contract.templateVersionId,
					recipientEmail
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
		if (previous) await ctx.db.replace('approvalRequests', previous._id, next);
		else await ctx.db.insert('approvalRequests', next);
		// The transaction just captured this context and scheduled its pending attempt.
		return {
			id: requestId,
			companyName: contract.companyName,
			selectedConcessions: selectedForClient(selections),
			requestedAt,
			status: 'sending',
			retryEligible: false
		};
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
		const review = contract.reviews[args.itemId];
		if (!review || review.concessionId !== args.concessionId)
			throw new ConvexError('This concession is missing review metadata.');
		const lifecycle = review.lifecycle;
		if (lifecycle !== args.lifecycle)
			throw new ConvexError('This concession was replaced. Review its current version.');
		const previousStatus = review.status;
		const changed = previousStatus !== args.status;
		if (changed) {
			const reviews = {
				...contract.reviews,
				[args.itemId]: { concessionId: args.concessionId, lifecycle, status: args.status }
			};
			const reviewGeneration = contract.reviewGeneration + 1;
			const reviewCompletion = completedReview({ ...contract, reviews })
				? {
						kind: 'awaitingConfirmation' as const,
						reviewerId: access._id
					}
				: undefined;
			const changes = {
				reviews,
				reviewGeneration,
				reviewCompletion,
				stateVersion: contract.stateVersion + 1
			};
			await ctx.db.patch('savedContracts', args.id, changes);
		}
		await recordDecision(ctx, contract, access, {
			itemId: args.itemId,
			concessionId: args.concessionId,
			lifecycle,
			operationId,
			previousStatus,
			status: args.status,
			decidedAt: Date.now(),
			changed
		});
		return null;
	}
});

const completionArgs = v.object({
	membershipId: v.id('memberships'),
	id: v.id('savedContracts'),
	expectedGeneration: v.number()
});
async function completionContract(ctx: QueryCtx, args: Infer<typeof completionArgs>) {
	const access = await requireMembership(ctx, args.membershipId);
	if (access.role !== 'admin') throw new ConvexError('Only company admins can manage reviews.');
	if (!Number.isSafeInteger(args.expectedGeneration) || args.expectedGeneration < 0)
		throw new ConvexError('Invalid review generation.');
	const contract = accessibleContract(await ctx.db.get('savedContracts', args.id), access);
	if (!contract) throw new ConvexError('This contract was deleted.');
	return contract;
}

export const confirmCompletion = mutation({
	args: completionArgs.fields,
	returns: v.object({ outcome: v.union(v.literal('queued'), v.literal('stale')) }),
	handler: async (ctx, args) => {
		const contract = await completionContract(ctx, args);
		const completion = contract.reviewCompletion;
		if (
			!completion ||
			contract.reviewGeneration !== args.expectedGeneration ||
			!completedReview(contract)
		)
			return { outcome: 'stale' as const };
		if (completion.kind === 'queued') return { outcome: 'queued' as const };
		const deliveryId = await createDelivery(ctx, {
			companyId: contract.companyId,
			event: {
				kind: 'decision',
				contractId: contract._id,
				reviewGeneration: contract.reviewGeneration,
				reviewerId: completion.reviewerId,
				companyName: contract.companyName,
				templateVersionId: contract.templateVersionId
			}
		});
		const reviewCompletion = {
			kind: 'queued' as const,
			deliveryId
		};
		await ctx.db.patch('savedContracts', contract._id, {
			reviewCompletion,
			stateVersion: contract.stateVersion + 1
		});
		return { outcome: 'queued' as const };
	}
});

export const resetCompletion = mutation({
	args: completionArgs.fields,
	returns: v.object({ outcome: v.union(v.literal('reset'), v.literal('stale')) }),
	handler: async (ctx, args) => {
		const contract = await completionContract(ctx, args);
		const completion = contract.reviewCompletion;
		if (
			completion?.kind !== 'awaitingConfirmation' ||
			contract.reviewGeneration !== args.expectedGeneration ||
			!completedReview(contract)
		)
			return { outcome: 'stale' as const };
		const reviewGeneration = contract.reviewGeneration + 1;
		const reviews = Object.fromEntries(
			Object.entries(contract.reviews).map(([id, review]) => [
				id,
				{
					...review,
					status: 'pending' as const,
					lifecycle: `reset:${reviewGeneration}:${id}`
				}
			])
		);
		const changes = {
			reviews,
			reviewGeneration,
			stateVersion: contract.stateVersion + 1,
			reviewCompletion: undefined,
			// A pre-reset save acknowledgement must not identify the reset as its own write.
			lastOperation: undefined,
			revision: contract.revision + 1,
			savedAt: Date.now()
		};
		const request = await latestFor(ctx, contract._id);
		if (request) {
			const delivery = await ctx.db.get('emailDeliveries', request.deliveryId);
			if (delivery) await removeDelivery(ctx, delivery);
			await ctx.db.delete('approvalRequests', request._id);
		}
		await ctx.db.patch('savedContracts', contract._id, changes);
		await writeDirectory(ctx, { ...contract, ...changes });
		return { outcome: 'reset' as const };
	}
});
