import { ConvexError } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import type { CompanyAccess } from './auth';
import { contractReadiness, type ContractConcession } from '../lib/contract/changes';
import type { ContractSaveResult } from '../lib/contract/saved';
import type { ValidationSourceFacts } from '../lib/document/validation-source';
import { toDocumentOverlay } from '../lib/playbook/document-overlay';
import { isRepItem } from '../lib/playbook/model';
import { activeConflicts } from '../lib/playbook/selection-conflicts';
import { MAX_SELECTED_CONCESSIONS } from '../lib/document/selection-limits';
import { syncBuyerLink } from './buyerLinks';
import { requireContractWork } from './contractPolicy';
import { stateOf } from './contracts';
import { patchContract, type Contract } from './contractState';
import { removeDelivery } from './emailDeliveries';
import { activity } from './hubspotRecords';
import { actionKey, actorOf, receipt, remember, validateOperationId } from './operationReceipts';
import { snapshotReader } from './templates';

/** Single-transaction Playbook concession save with optimistic concurrency and buyer-link auto-sync. */
export async function saveSelections(
	ctx: MutationCtx,
	access: CompanyAccess,
	contract: Contract,
	args: {
		operationId: string;
		expectedStateRevision: number;
		selections: Record<string, string>;
	}
): Promise<ContractSaveResult> {
	validateOperationId(args.operationId);
	const key = actionKey(access, 'save', args.operationId);
	const normalizedSelections = Object.fromEntries(
		Object.entries(args.selections).sort(([a], [b]) => a.localeCompare(b))
	);
	const inputs = JSON.stringify([
		contract.root._id,
		args.expectedStateRevision,
		normalizedSelections
	]);
	const prior = await receipt(ctx, key, inputs);
	if (prior) {
		if (prior.companyId !== access.companyId || prior.contractId !== contract.root._id)
			throw new Error('Save receipt ownership is invalid.');
		return JSON.parse(prior.result) as ContractSaveResult;
	}

	await requireContractWork(ctx, contract);

	if (contract.root.stateRevision !== args.expectedStateRevision)
		return { status: 'conflict', state: stateOf(contract) };

	const selectedEntries = Object.entries(normalizedSelections) as [Id<'playbookItems'>, string][];
	if (selectedEntries.length > MAX_SELECTED_CONCESSIONS)
		throw new ConvexError('Too many selected concessions.');

	const prevByItem = new Map(contract.root.concessions.map((entry) => [entry.itemId, entry]));
	if (
		selectedEntries.length === contract.root.concessions.length &&
		selectedEntries.every(([itemId, optionId]) => prevByItem.get(itemId)?.optionId === optionId)
	) {
		return { status: 'saved', state: stateOf(contract) };
	}

	const removedConcessions = contract.root.concessions.filter(
		(entry) => !(entry.itemId in normalizedSelections)
	);
	const removedNonApproved = removedConcessions.some((entry) => entry.status !== 'approved');
	const needRemovedItems =
		removedConcessions.length > 0 &&
		!removedNonApproved &&
		Boolean(contract.root.review.request || contract.root.review.completion);

	const reader = await snapshotReader(ctx, contract.root);
	const readIds = needRemovedItems
		? [...selectedEntries.map(([itemId]) => itemId), ...removedConcessions.map((c) => c.itemId)]
		: selectedEntries.map(([itemId]) => itemId);
	const hydratedItems = readIds.length > 0 ? await reader.readItemsByIds(readIds) : [];
	const itemsById = new Map(hydratedItems.map((item) => [item._id, item]));

	const selectedRepItems = [];
	for (const [itemId, optionId] of selectedEntries) {
		const item = itemsById.get(itemId);
		if (!item || !isRepItem(item) || !item.concessions.some((c) => c.id === optionId))
			throw new ConvexError('This Playbook option is unavailable.');
		selectedRepItems.push(item);
	}

	const itemsWithChanges = selectedRepItems.filter((item) => {
		const optionId = normalizedSelections[item._id];
		const option = item.concessions.find((c) => c.id === optionId);
		return Boolean(option && option.changes.length > 0);
	});
	let facts: ValidationSourceFacts | undefined;
	if (itemsWithChanges.length > 1) {
		facts = await reader.readSourceFacts();
		const overlays = itemsWithChanges.map((item) => toDocumentOverlay(item));
		if (activeConflicts(facts, overlays, normalizedSelections).length > 0)
			throw new ConvexError('Selected concessions conflict with each other.');
	}

	const nextConcessions: ContractConcession[] = selectedEntries.map(([itemId, optionId]) => {
		const item = itemsById.get(itemId)!;
		if (!isRepItem(item)) throw new ConvexError('This Playbook option is unavailable.');
		if (item.approvalPolicy.kind === 'none') {
			return { itemId, optionId, status: 'approved' };
		}
		const prev = prevByItem.get(itemId);
		if (prev && prev.optionId === optionId) {
			return { ...prev };
		}
		if (access.membership.role === 'admin') {
			return { itemId, optionId, status: 'approved' };
		}
		return { itemId, optionId, status: 'pending' };
	});

	const requiredSignature = (list: readonly ContractConcession[]) =>
		JSON.stringify(
			list
				.filter((entry) => {
					const item = itemsById.get(entry.itemId);
					return item && isRepItem(item) && item.approvalPolicy.kind === 'required';
				})
				.map((entry) => [entry.itemId, entry.optionId, entry.status])
		);

	const reviewChanged =
		removedNonApproved ||
		requiredSignature(contract.root.concessions) !== requiredSignature(nextConcessions);
	const nextReview = reviewChanged
		? { generation: contract.root.review.generation + 1 }
		: contract.root.review;
	if (reviewChanged) {
		const staleDeliveryIds = [
			contract.root.review.request?.deliveryId,
			contract.root.review.completion?.kind === 'queued'
				? contract.root.review.completion.deliveryId
				: undefined
		];
		for (const deliveryId of staleDeliveryIds) {
			if (!deliveryId) continue;
			const delivery = await ctx.db.get('emailDeliveries', deliveryId);
			if (delivery) await removeDelivery(ctx, delivery);
		}
	}

	const now = Date.now();
	const savedAt = Math.max(now, contract.root.savedAt + 1);
	for (const [itemId, optionId] of selectedEntries) {
		if (prevByItem.get(itemId)?.optionId === optionId) continue;
		const item = itemsById.get(itemId)!;
		if (!isRepItem(item)) continue;
		const option = item.concessions.find((c) => c.id === optionId)!;
		await activity(
			ctx,
			contract,
			actorOf(access.profile),
			`${key}:applied:${itemId}:${optionId}`,
			'applied',
			JSON.stringify({
				itemId,
				contentRevision: item.contentRevision,
				concessionId: optionId,
				description: option.description
			}),
			now
		);
	}

	const updated = await patchContract(ctx, contract, {
		concessions: nextConcessions,
		review: nextReview,
		savedAt,
		stateRevision: contract.root.stateRevision + 1,
		lastOperation: { id: args.operationId, callerId: access.profile._id }
	});

	if (contractReadiness(nextConcessions).ready) {
		await syncBuyerLink(ctx, updated.root, { itemsById, facts });
	}

	const result: ContractSaveResult = { status: 'saved', state: stateOf(updated) };
	await remember(ctx, access.companyId, key, inputs, JSON.stringify(result), contract.root._id);
	return result;
}
