import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import { internalMutation, mutation, query } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import schema from './schema';
import {
	contractCard,
	contractState,
	contractMetadata,
	saveResult,
	selections
} from './savedContractValidators';
import { currentPointer, snapshotReader } from './templates';
import { CompiledContract } from '../lib/contract/compiled-contract';
import { toDocumentOverlay } from '../lib/playbook/document-overlay';
import { activeConflicts } from '../lib/playbook/selection-conflicts';
import { sameSelection } from '../lib/playbook/model';
import { requireMembership, accessibleContract, scopedOperation } from './auth';
import { internal } from './_generated/api';
import { selectionLifecycles, type concessionReviews } from './contractValidators';
import type { Infer } from 'convex/values';
import { attribution, updateAttributions } from './reviewAttributions';
import { cancelJob } from './emailDeliveries';
import { readDirectory, writeDirectory, removeDirectoryEntry } from './contractDirectory';

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
		lastOperationId: contract.lastOperationId ?? null
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
		directoryReady: v.optional(v.boolean()),
		paginationOpts: paginationOptsValidator
	},
	returns: paginationResultValidator(contractCard),
	handler: async (ctx, args) => {
		const profile = await requireMembership(ctx, args.membershipId);
		return readDirectory(
			ctx,
			profile.company,
			args.search,
			args.paginationOpts,
			args.directoryReady === true
		);
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
		return contract
			? {
					...stateOf(contract),
					_id: contract._id,
					_creationTime: contract._creationTime,
					companyId: contract.companyId,
					creatorId: contract.creatorId,
					templateVersionId: contract.templateVersionId,
					savedAt: contract.savedAt
				}
			: null;
	}
});

export const create = mutation({
	args: { membershipId: v.id('memberships'), companyName: v.string(), operationId: v.string() },
	returns: v.union(
		v.object({
			status: v.literal('created'),
			id: v.id('savedContracts'),
			contract: schema.doc('savedContracts')
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
			return { status: 'created' as const, id: receipt.contractId, contract };
		}
		const name = companyName(args.companyName);
		const pointer = await currentPointer(ctx, profile.companyId);
		if (pointer?.maintenance)
			throw new ConvexError('Template maintenance is in progress. Try again shortly.');
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
			templateVersionId: version._id
		});
		await ctx.db.insert('contractCreationReceipts', {
			companyId: profile.companyId,
			operationId: scopedOperation(profile, args.operationId),
			contractId: id
		});
		const contract = (await ctx.db.get('savedContracts', id))!;
		await writeDirectory(ctx, contract);
		return { status: 'created' as const, id, contract };
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
		if (contract.lastOperationId === operationId && contract.lastOperationCaller === profile._id)
			return { status: 'saved' as const, state: stateOf(contract) };
		if (contract.revision !== expectedRevision)
			return { status: 'conflict' as const, state: stateOf(contract) };
		// An unchanged save acknowledges current state without consuming a revision or
		// operation ID. A retry after an intervening change still follows conflict rules.
		if (
			sameSelection(contract.selectedConcessions, selectedConcessions) &&
			sameSelection(
				lifecycles,
				Object.fromEntries(
					Object.entries(contract.reviews).map(([id, review]) => [id, review.lifecycle])
				)
			)
		)
			return { status: 'saved' as const, state: stateOf(contract) };
		// Snapshots are validated once at publication and never edited. Validate membership
		// first; baseline compilation is only needed to check conflicts between items.
		const reviews: Infer<typeof concessionReviews> = {};
		const attributions: ReturnType<typeof attribution>[] = [];
		if (Object.keys(selectedConcessions).length) {
			const reader = await snapshotReader(ctx, contract);
			const items = await reader.selectedItems(selectedConcessions);
			for (const item of items) {
				if (!item.instructions?.changesNeedApproval?.trim()) continue;
				const concessionId = selectedConcessions[item._id];
				const previous = contract.reviews[item._id];
				const lifecycle = lifecycles[item._id];
				if (!lifecycle?.trim() || lifecycle.length > 300)
					throw new ConvexError('Invalid concession application.');
				const unchanged =
					previous?.concessionId === concessionId && previous.lifecycle === lifecycle;
				reviews[item._id] = unchanged
					? previous
					: { concessionId, lifecycle, status: profile.role === 'admin' ? 'approved' : 'pending' };
				if (!unchanged && profile.role === 'admin') {
					attributions.push(attribution(item._id, concessionId, lifecycle, profile));
					await ctx.db.insert('concessionDecisions', {
						companyId: profile.companyId,
						contractId: id,
						itemId: item._id,
						concessionId,
						lifecycle,
						adminId: profile._id,
						adminName: profile.name,
						adminEmail: profile.email,
						operationId: scopedOperation(profile, JSON.stringify(['save', operationId, item._id])),
						previousStatus: 'pending',
						status: 'approved',
						decidedAt: Date.now(),
						changed: true
					});
				}
			}
			if (items.length > 1) {
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
		const revision = expectedRevision + 1;
		const reviewGeneration = (contract.reviewGeneration ?? 0) + 1;
		await updateAttributions(ctx, contract, reviews, attributions);
		const savedAt = Date.now();
		await ctx.db.patch('savedContracts', id, {
			selectedConcessions,
			reviews,
			revision,
			reviewGeneration,
			lastOperationId: operationId,
			lastOperationCaller: profile._id,
			savedAt
		});
		await writeDirectory(ctx, { ...contract, savedAt });
		return {
			status: 'saved' as const,
			state: stateOf({
				...contract,
				selectedConcessions,
				reviews,
				revision,
				lastOperationId: operationId
			})
		};
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
		await ctx.db.patch('savedContracts', id, { companyName: name, savedAt });
		await writeDirectory(ctx, { ...contract, companyName: name, savedAt });
		return null;
	}
});

export const remove = mutation({
	args: { membershipId: v.id('memberships'), id: v.id('savedContracts') },
	returns: v.null(),
	handler: async (ctx, { id, membershipId }) => {
		const profile = await requireMembership(ctx, membershipId);
		if (!accessibleContract(await ctx.db.get('savedContracts', id), profile)) return null;
		const request = await ctx.db
			.query('approvalRequests')
			.withIndex('by_contractId', (q) => q.eq('contractId', id))
			.unique();
		if (request) {
			if (!('deliveryId' in request)) await cancelJob(ctx, request.sendJobId);
			await ctx.db.delete('approvalRequests', request._id);
		}
		await ctx.scheduler.runAfter(0, internal.savedContracts.removeDecisionHistory, { id });
		await ctx.scheduler.runAfter(0, internal.emailDeliveries.removeForContract, { id });
		await removeDirectoryEntry(ctx, id);
		await ctx.db.delete('savedContracts', id);
		return null;
	}
});

/** Bounded cleanup: history grows independently of the contract document. */
export const removeDecisionHistory = internalMutation({
	args: { id: v.id('savedContracts') },
	returns: v.null(),
	handler: async (ctx, { id }) => {
		const rows = await ctx.db
			.query('concessionDecisions')
			.withIndex('by_contractId', (q) => q.eq('contractId', id))
			.take(100);
		for (const row of rows) await ctx.db.delete('concessionDecisions', row._id);
		if (rows.length === 100)
			await ctx.scheduler.runAfter(0, internal.savedContracts.removeDecisionHistory, { id });
		return null;
	}
});
