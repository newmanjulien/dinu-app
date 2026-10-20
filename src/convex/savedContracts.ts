import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import { internalMutation, mutation, query } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import schema from './schema';
import {
	contractCard,
	contractState,
	saveResult,
	selections,
	snapshot
} from './savedContractValidators';
import { currentPointer, snapshotReader } from './templates';
import { CompiledContract } from '../lib/contract/compiled-contract';
import { toDocumentOverlay } from '../lib/playbook/document-overlay';
import { activeConflicts } from '../lib/playbook/selection-conflicts';
import { sameSelection } from '../lib/playbook/model';
import { requireMembership, accessibleContract, liveProfile, scopedOperation } from './auth';
import { internal } from './_generated/api';
import { selectionLifecycles, type concessionReviews } from './contractValidators';
import type { Infer } from 'convex/values';
import { legacyLifecycle } from '../lib/contract/approval';

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
		reviews: contract.reviews ?? {},
		revision: contract.revision ?? 0,
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
		paginationOpts: paginationOptsValidator
	},
	returns: paginationResultValidator(contractCard),
	handler: async (ctx, args) => {
		const profile = await requireMembership(ctx, args.membershipId);
		const companyId = profile.companyId;
		const search = args.search.trim().slice(0, 200);
		const contracts = ctx.db.query('savedContracts');
		const query = search
			? contracts.withSearchIndex('search_companyName', (q) =>
					q.search('companyName', search).eq('companyId', profile.companyId)
				)
			: contracts
					.withIndex('by_companyId_and_savedAt', (q) => q.eq('companyId', profile.companyId))
					.order('desc');
		const result = await query.paginate(args.paginationOpts);
		const creators = new Map<
			Id<'profiles'> | undefined,
			Promise<{
				name: string;
				avatarUrl: string | null;
			}>
		>();
		function resolveCreator(id: Id<'profiles'> | undefined) {
			let creator = creators.get(id);
			if (!creator) {
				creator = (async () => {
					const profile = await liveProfile(ctx, id);
					if (!profile) return { name: 'Former colleague', avatarUrl: null };
					const member = await ctx.db
						.query('memberships')
						.withIndex('by_profileId', (q) => q.eq('profileId', profile._id))
						.unique();
					if (member?.companyId !== companyId) return { name: 'Former colleague', avatarUrl: null };
					return {
						name: profile.name || profile.email || 'Colleague',
						avatarUrl: profile.avatarId ? await ctx.storage.getUrl(profile.avatarId) : null
					};
				})();
				creators.set(id, creator);
			}
			return creator;
		}
		return {
			...result,
			page: await Promise.all(
				result.page.map(async (contract) => ({
					_id: contract._id,
					companyName: contract.companyName,
					savedAt: contract.savedAt,
					creator: await resolveCreator(contract.creatorId)
				}))
			)
		};
	}
});

export const load = query({
	// Invalid URLs return the same missing state as deleted contracts.
	args: { membershipId: v.id('memberships'), id: v.string() },
	returns: v.union(
		v.null(),
		v.object({
			contract: schema.doc('savedContracts'),
			snapshot
		})
	),
	handler: async (ctx, { id, membershipId }) => {
		const profile = await requireMembership(ctx, membershipId);
		const contractId = ctx.db.normalizeId('savedContracts', id);
		const contract = contractId
			? accessibleContract(await ctx.db.get('savedContracts', contractId), profile)
			: null;
		if (!contract) return null;
		const reader = await snapshotReader(ctx, contract);
		return { contract, snapshot: await reader.read() };
	}
});

export const state = query({
	// Like full reads, route IDs may be malformed or refer to deleted contracts.
	args: { membershipId: v.id('memberships'), id: v.string() },
	returns: v.union(contractState, v.null()),
	handler: async (ctx, { id, membershipId }) => {
		const profile = await requireMembership(ctx, membershipId);
		const contractId = ctx.db.normalizeId('savedContracts', id);
		const contract = contractId
			? accessibleContract(await ctx.db.get('savedContracts', contractId), profile)
			: null;
		return contract ? stateOf(contract) : null;
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
			revision: 0,
			templateVersionId: version._id
		});
		await ctx.db.insert('contractCreationReceipts', {
			companyId: profile.companyId,
			operationId: scopedOperation(profile, args.operationId),
			contractId: id
		});
		const contract = (await ctx.db.get('savedContracts', id))!;
		return { status: 'created' as const, id, contract };
	}
});

export const saveChoices = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('savedContracts'),
		selectedConcessions: selections,
		selectionLifecycles: v.optional(selectionLifecycles),
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
		if ((contract.revision ?? 0) !== expectedRevision)
			return { status: 'conflict' as const, state: stateOf(contract) };
		// An unchanged save acknowledges current state without consuming a revision or
		// operation ID. A retry after an intervening change still follows conflict rules.
		if (
			sameSelection(contract.selectedConcessions, selectedConcessions) &&
			Object.entries(lifecycles ?? {}).every(
				([itemId, lifecycle]) =>
					lifecycle ===
					(contract.reviews?.[itemId as Id<'playbookItems'>]?.lifecycle ??
						legacyLifecycle(itemId, selectedConcessions[itemId as Id<'playbookItems'>]))
			)
		)
			return { status: 'saved' as const, state: stateOf(contract) };
		// Snapshots are validated once at publication and never edited. Validate membership
		// first; baseline compilation is only needed to check conflicts between items.
		const reviews: Infer<typeof concessionReviews> = {};
		if (Object.keys(selectedConcessions).length) {
			const reader = await snapshotReader(ctx, contract);
			const items = await reader.selectedItems(selectedConcessions);
			for (const item of items) {
				if (!item.instructions?.changesNeedApproval?.trim()) continue;
				const concessionId = selectedConcessions[item._id];
				const previous = contract.reviews?.[item._id];
				const lifecycle =
					lifecycles?.[item._id] ??
					(contract.selectedConcessions[item._id] === concessionId
						? (previous?.lifecycle ?? legacyLifecycle(item._id, concessionId))
						: `${operationId}:${item._id}`);
				if (!lifecycle.trim() || lifecycle.length > 300)
					throw new ConvexError('Invalid concession application.');
				const unchanged =
					contract.selectedConcessions[item._id] === concessionId &&
					lifecycle === (previous?.lifecycle ?? legacyLifecycle(item._id, concessionId));
				reviews[item._id] = unchanged
					? (previous ?? { concessionId, lifecycle, status: 'pending' })
					: { concessionId, lifecycle, status: profile.role === 'admin' ? 'approved' : 'pending' };
				if (!unchanged && profile.role === 'admin')
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
			if (items.length > 1) {
				const blocks = await reader.blocks();
				const compiled = new CompiledContract(blocks);
				if (
					activeConflicts(compiled.index, items.map(toDocumentOverlay), selectedConcessions).length
				)
					throw new ConvexError('Remove conflicting concessions before saving.');
			}
		}
		const revision = expectedRevision + 1;
		await ctx.db.patch('savedContracts', id, {
			selectedConcessions,
			reviews,
			revision,
			lastOperationId: operationId,
			lastOperationCaller: profile._id,
			savedAt: Date.now()
		});
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
		await ctx.db.patch('savedContracts', id, { companyName: name, savedAt: Date.now() });
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
			const job = await ctx.db.system.get('_scheduled_functions', request.sendJobId);
			if (job?.state.kind === 'pending' || job?.state.kind === 'inProgress')
				await ctx.scheduler.cancel(request.sendJobId);
			await ctx.db.delete('approvalRequests', request._id);
		}
		await ctx.scheduler.runAfter(0, internal.savedContracts.removeDecisionHistory, { id });
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
