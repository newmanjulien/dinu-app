import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import { mutation, query } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { contractCard, contractMetadata, saveResult, selections } from './savedContractValidators';
import { currentPointer, snapshotReader } from './templates';
import { CompiledContract } from '../lib/contract/compiled-contract';
import { toDocumentOverlay } from '../lib/playbook/document-overlay';
import { activeConflicts } from '../lib/playbook/selection-conflicts';
import { sameSelection } from '../lib/playbook/model';
import { requireMembership, accessibleContract, scopedOperation } from './auth';
import { selectionLifecycles, type concessionReviews } from './contractValidators';
import type { Infer } from 'convex/values';
import { reviewsForSelections, recordDecision } from './reviews';
import { readDirectory, writeDirectory, removeDirectoryEntry } from './contractDirectory';
import { ensureContractCleanup } from './contractCleanup';

function companyName(value: string) {
	const name = value.trim();
	if (!name) throw new ConvexError('Enter a buyer company name.');
	if (name.length > 200) throw new ConvexError('Company names must be 200 characters or fewer.');
	return name;
}

function stateOf(contract: Doc<'savedContracts'>) {
	return {
		companyName: contract.companyName,
		selectedConcessions: contract.selectedConcessions,
		reviews: contract.reviews,
		revision: contract.revision,
		reviewGeneration: contract.reviewGeneration,
		reviewCompletion:
			contract.reviewCompletion?.kind === 'awaitingConfirmation'
				? {
						kind: 'awaitingConfirmation' as const,
						reviewerId: contract.reviewCompletion.reviewerId
					}
				: contract.reviewCompletion?.kind === 'queued'
					? { kind: 'queued' as const, deliveryId: contract.reviewCompletion.deliveryId }
					: null,
		stateVersion: contract.stateVersion ?? 1,
		lastOperationId: contract.lastOperation?.id ?? null
	};
}

function metadataOf(contract: Doc<'savedContracts'>) {
	return {
		...stateOf(contract),
		_id: contract._id,
		_creationTime: contract._creationTime,
		companyId: contract.companyId,
		creatorId: contract.creatorId,
		templateVersionId: contract.templateVersionId,
		savedAt: contract.savedAt
	};
}

function validateOperationId(operationId: string) {
	if (!operationId.trim() || operationId.length > 200)
		throw new ConvexError('Invalid save operation.');
}

export const browse = query({
	args: {
		membershipId: v.id('memberships'),
		search: v.string(),
		paginationOpts: paginationOptsValidator
	},
	returns: paginationResultValidator(contractCard),
	handler: async (ctx, args) => {
		const profile = await requireMembership(ctx, args.membershipId);
		return readDirectory(ctx, profile.companyId, args.search, args.paginationOpts);
	}
});

export const state = query({
	// Like full reads, route IDs may be malformed or refer to deleted contracts.
	args: { membershipId: v.id('memberships'), id: v.string() },
	returns: v.union(contractMetadata, v.null()),
	handler: async (ctx, { id, membershipId }) => {
		const profile = await requireMembership(ctx, membershipId);
		const contractId = ctx.db.normalizeId('savedContracts', id);
		const contract = contractId
			? accessibleContract(await ctx.db.get('savedContracts', contractId), profile)
			: null;
		return contract ? metadataOf(contract) : null;
	}
});

export const create = mutation({
	args: { membershipId: v.id('memberships'), companyName: v.string(), operationId: v.string() },
	returns: v.union(
		v.object({
			status: v.literal('created'),
			id: v.id('savedContracts'),
			contract: contractMetadata
		}),
		v.object({ status: v.literal('deleted') })
	),
	handler: async (ctx, args) => {
		const profile = await requireMembership(ctx, args.membershipId);
		validateOperationId(args.operationId);
		const receipt = await ctx.db
			.query('contractCreationReceipts')
			.withIndex('by_operationId', (q) =>
				q.eq('operationId', scopedOperation(profile, args.operationId))
			)
			.unique();
		if (receipt) {
			const contract = accessibleContract(
				await ctx.db.get('savedContracts', receipt.contractId),
				profile
			);
			if (!contract) return { status: 'deleted' as const };
			return { status: 'created' as const, id: receipt.contractId, contract: metadataOf(contract) };
		}
		const name = companyName(args.companyName);
		const pointer = await currentPointer(ctx, profile.companyId);
		const version = pointer?.versionId
			? await ctx.db.get('templateVersions', pointer.versionId)
			: null;
		if (!version || version.companyId !== profile.companyId)
			throw new ConvexError('The baseline contract is not available.');
		const id = await ctx.db.insert('savedContracts', {
			companyId: profile.companyId,
			companyName: name,
			creatorId: profile._id,
			savedAt: Date.now(),
			selectedConcessions: {},
			reviews: {},
			revision: 0,
			reviewGeneration: 0,
			stateVersion: 1,
			templateVersionId: version._id
		});
		await ctx.db.insert('contractCreationReceipts', {
			companyId: profile.companyId,
			operationId: scopedOperation(profile, args.operationId),
			contractId: id
		});
		if (version.draft) await ctx.db.patch('templateVersions', version._id, { draft: false });
		const contract = (await ctx.db.get('savedContracts', id))!;
		await writeDirectory(ctx, contract);
		return { status: 'created' as const, id, contract: metadataOf(contract) };
	}
});

export const saveChoices = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('savedContracts'),
		selectedConcessions: selections,
		selectionLifecycles,
		expectedRevision: v.number(),
		operationId: v.string()
	},
	returns: saveResult,
	handler: async (
		ctx,
		{
			id,
			membershipId,
			selectedConcessions,
			selectionLifecycles: lifecycles,
			expectedRevision,
			operationId
		}
	) => {
		const profile = await requireMembership(ctx, membershipId);
		validateOperationId(operationId);
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
			throw new ConvexError('Invalid contract revision.');
		const contract = accessibleContract(await ctx.db.get('savedContracts', id), profile);
		if (!contract) return { status: 'deleted' as const };
		// A replay is acknowledged before checking its now-stale expected revision.
		if (
			contract.lastOperation?.id === operationId &&
			contract.lastOperation.callerId === profile._id
		)
			return { status: 'saved' as const, state: stateOf(contract) };
		if (contract.revision !== expectedRevision)
			return { status: 'conflict' as const, state: stateOf(contract) };
		// An unchanged save acknowledges current state without consuming a revision or
		// operation ID. A retry after an intervening change still follows conflict rules.
		const choicesUnchanged = sameSelection(contract.selectedConcessions, selectedConcessions);
		if (
			choicesUnchanged &&
			Object.keys(lifecycles).length === Object.keys(contract.reviews).length &&
			Object.entries(contract.reviews).every(
				([id, review]) => lifecycles[id as Id<'playbookItems'>] === review.lifecycle
			)
		)
			return { status: 'saved' as const, state: stateOf(contract) };
		// Snapshots are validated once at publication and never edited. Validate membership
		// first; baseline compilation is only needed to check conflicts between items.
		let reviews: Infer<typeof concessionReviews> = {};
		let autoApprovedItemIds: Id<'playbookItems'>[] = [];
		if (Object.keys(selectedConcessions).length) {
			const reader = await snapshotReader(ctx, contract);
			const items = await reader.selectedItems(selectedConcessions);
			const application = reviewsForSelections(
				items,
				selectedConcessions,
				lifecycles,
				contract.reviews,
				profile.role
			);
			reviews = application.reviews;
			autoApprovedItemIds = application.autoApprovedItemIds;
			// Existing choices have already passed this check against the same immutable
			// version. A new application identity changes reviews, never document geometry.
			if (items.length > 1 && !choicesUnchanged) {
				const blocks = await reader.blocks();
				const compiled = new CompiledContract(blocks);
				if (
					activeConflicts(compiled.index, items.map(toDocumentOverlay), selectedConcessions).length
				)
					throw new ConvexError('Remove conflicting concessions before saving.');
			}
		}
		if (Object.keys(lifecycles).some((id) => !reviews[id as Id<'playbookItems'>]))
			throw new ConvexError('Invalid concession application.');
		// All input and conflict validation precedes writes, including auto-approval audit.
		const changes = {
			selectedConcessions,
			reviews,
			revision: contract.revision + 1,
			reviewGeneration: contract.reviewGeneration + 1,
			stateVersion: (contract.stateVersion ?? 1) + 1,
			reviewCompletion: undefined,
			lastOperation: { id: operationId, callerId: profile._id },
			savedAt: Date.now()
		};
		for (const itemId of autoApprovedItemIds) {
			const { concessionId, lifecycle } = reviews[itemId];
			await recordDecision(ctx, contract, profile, {
				itemId,
				concessionId,
				lifecycle,
				operationId: scopedOperation(profile, JSON.stringify(['save', operationId, itemId])),
				previousStatus: 'pending',
				status: 'approved',
				decidedAt: changes.savedAt,
				changed: true
			});
		}
		await ctx.db.patch('savedContracts', id, changes);
		const next = { ...contract, ...changes };
		await writeDirectory(ctx, next);
		return { status: 'saved' as const, state: stateOf(next) };
	}
});

export const rename = mutation({
	args: { membershipId: v.id('memberships'), id: v.id('savedContracts'), companyName: v.string() },
	returns: v.null(),
	handler: async (ctx, { id, membershipId, companyName: value }) => {
		const profile = await requireMembership(ctx, membershipId);
		const contract = accessibleContract(await ctx.db.get('savedContracts', id), profile);
		if (!contract) throw new ConvexError('This contract was deleted.');
		const name = companyName(value);
		if (name === contract.companyName) return null;
		const savedAt = Date.now();
		await ctx.db.patch('savedContracts', id, {
			companyName: name,
			savedAt,
			stateVersion: (contract.stateVersion ?? 1) + 1
		});
		await writeDirectory(ctx, { ...contract, companyName: name, savedAt });
		return null;
	}
});

export const remove = mutation({
	args: { membershipId: v.id('memberships'), id: v.id('savedContracts') },
	returns: v.null(),
	handler: async (ctx, { id, membershipId }) => {
		const profile = await requireMembership(ctx, membershipId);
		const contract = accessibleContract(await ctx.db.get('savedContracts', id), profile);
		await ensureContractCleanup(ctx, profile.companyId, id, Boolean(contract));
		if (!contract) return null;
		const request = await ctx.db
			.query('approvalRequests')
			.withIndex('by_contractId', (q) => q.eq('contractId', id))
			.unique();
		if (request) await ctx.db.delete('approvalRequests', request._id);
		await removeDirectoryEntry(ctx, id);
		await ctx.db.delete('savedContracts', id);
		return null;
	}
});
