import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { ConvexError, v, type Infer } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import { accessibleContract, requireMembership, type CompanyAccess } from './auth';
import { buyerName } from './contractBuyer';
import { ensureContractCleanup } from './contractCleanup';
import { readDirectory, writeDirectory } from './contractDirectory';
import { contractWorkBlock, installation, requireContractWork } from './contractPolicy';
import { saveSelections } from './contractSaving';
import {
	accessibleContractState,
	assertHubspotAssociationAvailable,
	clearBuyerRefresh,
	patchContract,
	readContract,
	type Contract,
	type ContractHubspotLink
} from './contractState';
import { requestDeliveryStatus, selections } from './contractValidators';
import { UNCERTAIN_COOLDOWN } from './emailDeliveries';
import { actionKey, receipt, remember, validateOperationId } from './operationReceipts';
import {
	contractCard,
	contractMetadata,
	liveContractMetadata,
	saveResult
} from './savedContractValidators';
import { assertStorageCapacity } from './storageCapacity';
import { currentPointer } from './templates';

function contractTitle(value: string) {
	const name = value.trim();
	if (!name) throw new ConvexError('Enter a contract name.');
	if (name.length > 200) throw new ConvexError('Contract names must be 200 characters or fewer.');
	return name;
}

export function stateOf(contract: Contract) {
	return {
		title: contract.root.title,
		stateRevision: contract.root.stateRevision,
		metadataRevision: contract.root.metadataRevision,
		concessions: contract.root.concessions,
		review: contract.root.review,
		hubspot: contract.hubspot,
		lastOperationId: contract.root.lastOperation?.id ?? null
	};
}

export function metadataOf(contract: Contract) {
	return {
		...stateOf(contract),
		_id: contract.root._id,
		_creationTime: contract.root._creationTime,
		companyId: contract.root.companyId,
		creatorId: contract.root.creatorId,
		templateVersionId: contract.root.templateVersionId,
		savedAt: contract.root.savedAt
	};
}

export function deliveryStatusOf(
	request: NonNullable<Doc<'savedContracts'>['review']['request']>,
	delivery: Doc<'emailDeliveries'> | null
): Infer<typeof requestDeliveryStatus> | null {
	if (!delivery || delivery.event.kind !== 'approval') return null;
	const state = delivery.state;
	if (state.kind === 'skipped') return null;
	if (state.kind === 'sending') {
		return {
			generation: request.generation,
			requestedAt: request.requestedAt,
			status: 'sending',
			retryEligible: false
		};
	}
	if (state.kind === 'sent') {
		return {
			generation: request.generation,
			requestedAt: request.requestedAt,
			status: 'sent',
			completedAt: state.completedAt,
			retryEligible: false
		};
	}
	if (state.kind === 'uncertain') {
		return {
			generation: request.generation,
			requestedAt: request.requestedAt,
			status: 'uncertain',
			completedAt: state.completedAt,
			error: state.error,
			retryAt: state.completedAt + UNCERTAIN_COOLDOWN,
			retryEligible: state.retryEligible
		};
	}
	return {
		generation: request.generation,
		requestedAt: request.requestedAt,
		status: 'failed',
		completedAt: state.completedAt,
		error: state.error,
		retryEligible: true
	};
}

async function requestDeliveryOf(ctx: QueryCtx, root: Doc<'savedContracts'>) {
	const request = root.review.request;
	if (!request || request.generation !== root.review.generation) return null;
	const delivery = await ctx.db.get('emailDeliveries', request.deliveryId);
	return deliveryStatusOf(request, delivery);
}

export const browse = query({
	args: {
		membershipId: v.id('memberships'),
		search: v.string(),
		paginationOpts: paginationOptsValidator
	},
	returns: paginationResultValidator(contractCard),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		return readDirectory(ctx, access.companyId, args.search, args.paginationOpts);
	}
});

/** Small authorized read for the browser title before a contract page is rendered. */
export const routeTitle = query({
	args: { id: v.string() },
	returns: v.union(
		v.object({ kind: v.literal('current'), buyerName: v.union(v.string(), v.null()) }),
		v.object({ kind: v.literal('unavailable') })
	),
	handler: async (ctx, { id }) => {
		const access = await requireMembership(ctx);
		const contractId = ctx.db.normalizeId('savedContracts', id);
		const contract = contractId
			? accessibleContract(await ctx.db.get('savedContracts', contractId), access)
			: null;
		return contract
			? { kind: 'current' as const, buyerName: buyerName(contract) }
			: { kind: 'unavailable' as const };
	}
});

export const state = query({
	args: {
		membershipId: v.id('memberships'),
		id: v.string()
	},
	returns: v.union(liveContractMetadata, v.null()),
	handler: async (ctx, { id, membershipId }) => {
		const access = await requireMembership(ctx, membershipId);
		const contractId = ctx.db.normalizeId('savedContracts', id);
		const contract = contractId ? await accessibleContractState(ctx, contractId, access) : null;
		if (!contract) return null;
		const [workBlock, requestDelivery] = await Promise.all([
			contractWorkBlock(ctx, contract),
			requestDeliveryOf(ctx, contract.root)
		]);
		return {
			...metadataOf(contract),
			buyerName: buyerName(contract.root),
			workBlock,
			requestDelivery
		};
	}
});

export const create = mutation({
	args: {
		membershipId: v.id('memberships'),
		title: v.string(),
		operationId: v.string()
	},
	returns: v.union(
		v.object({
			status: v.literal('created'),
			id: v.id('savedContracts'),
			contract: contractMetadata
		}),
		v.object({ status: v.literal('deleted') }),
		v.object({ status: v.literal('association-required') })
	),
	handler: async (ctx, args) => {
		const access = await requireMembership(ctx, args.membershipId);
		validateOperationId(args.operationId);
		const key = actionKey(access, 'create', args.operationId);
		const inputs = JSON.stringify([args.title]);
		const prior = await receipt(ctx, key, inputs);
		if (prior) {
			if (prior.companyId !== access.companyId)
				throw new Error('Create receipt ownership is invalid.');
			const contractId = ctx.db.normalizeId('savedContracts', prior.result);
			const contract = contractId ? await accessibleContractState(ctx, contractId, access) : null;
			if (!contract) return { status: 'deleted' as const };
			return {
				status: 'created' as const,
				id: contract.root._id,
				contract: metadataOf(contract)
			};
		}
		if (await installation(ctx, access.companyId))
			return { status: 'association-required' as const };
		const name = contractTitle(args.title);
		const contract = await createContract(ctx, access, name);
		await remember(ctx, access.companyId, key, inputs, contract.root._id, contract.root._id);
		return {
			status: 'created' as const,
			id: contract.root._id,
			contract: metadataOf(contract)
		};
	}
});

export const save = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('savedContracts'),
		operationId: v.string(),
		expectedStateRevision: v.number(),
		selections
	},
	returns: saveResult,
	handler: async (ctx, { id, membershipId, operationId, expectedStateRevision, selections }) => {
		const access = await requireMembership(ctx, membershipId);
		validateOperationId(operationId);
		const contract = await accessibleContractState(ctx, id, access);
		if (!contract) return { status: 'deleted' as const };
		return saveSelections(ctx, access, contract, {
			operationId,
			expectedStateRevision,
			selections
		});
	}
});

export const rename = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('savedContracts'),
		title: v.string()
	},
	returns: v.null(),
	handler: async (ctx, { id, membershipId, title: value }) => {
		const access = await requireMembership(ctx, membershipId);
		const contract = await accessibleContractState(ctx, id, access);
		if (!contract) throw new ConvexError('This contract was deleted.');
		const name = contractTitle(value);
		if (name === contract.root.title) return null;
		await requireContractWork(ctx, contract);
		const savedAt = Math.max(Date.now(), contract.root.savedAt + 1);
		await patchContract(ctx, contract, {
			title: name,
			...(!(await installation(ctx, access.companyId))
				? { buyer: { kind: 'manual' as const } }
				: {}),
			savedAt
		});
		return null;
	}
});

export const remove = mutation({
	args: { membershipId: v.id('memberships'), id: v.id('savedContracts') },
	returns: v.null(),
	handler: async (ctx, { id, membershipId }) => {
		const access = await requireMembership(ctx, membershipId);
		const contract = await accessibleContractState(ctx, id, access);
		await ensureContractCleanup(ctx, access.companyId, id, Boolean(contract));
		if (!contract) return null;
		await clearBuyerRefresh(ctx, access.companyId, id);
		if (contract.hubspotAssociationId)
			await ctx.db.delete('contractHubspotAssociations', contract.hubspotAssociationId);
		await ctx.db.delete('savedContracts', id);
		return null;
	}
});

export async function createContract(
	ctx: MutationCtx,
	access: CompanyAccess,
	name: string,
	hubspot?: ContractHubspotLink
) {
	await requireContractWork(ctx, { root: { companyId: access.companyId }, hubspot });
	const pointer = await currentPointer(ctx, access.companyId);
	const version = pointer?.versionId
		? await ctx.db.get('templateVersions', pointer.versionId)
		: null;
	if (!version || version.companyId !== access.companyId)
		throw new ConvexError('The contract template is not available.');
	await assertStorageCapacity(ctx, { documents: 4, bytes: 16_000 });
	const id = await ctx.db.insert('savedContracts', {
		companyId: access.companyId,
		title: name,
		buyer: hubspot ? { kind: 'hubspot', company: null } : { kind: 'manual' },
		creatorId: access.profile._id,
		templateVersionId: version._id,
		stateRevision: 0,
		metadataRevision: 0,
		concessions: [],
		review: { generation: 0 },
		savedAt: Date.now()
	});
	if (hubspot) {
		await assertHubspotAssociationAvailable(ctx, access.companyId, id, hubspot);
		await ctx.db.insert('contractHubspotAssociations', {
			companyId: access.companyId,
			contractId: id,
			...hubspot
		});
	}
	if (version.mutability === 'mutable')
		await ctx.db.patch('templateVersions', version._id, { mutability: 'frozen' as const });
	const contract = await readContract(ctx, (await ctx.db.get('savedContracts', id))!);
	await writeDirectory(ctx, contract);
	return contract;
}
