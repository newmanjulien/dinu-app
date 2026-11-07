import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import { applicationChoices, sameApplications, choicesOf } from '../lib/contract/applications';
import type { Doc, Id } from './_generated/dataModel';
import { mutation, query, type MutationCtx } from './_generated/server';
import { accessibleContract, requireMembership, scopedOperation, type CompanyAccess } from './auth';
import { ensureContractCleanup } from './contractCleanup';
import { readDirectory, removeDirectoryEntry, writeDirectory } from './contractDirectory';
import { contractCard, contractMetadata, saveResult } from './savedContractValidators';
import { activityCommand } from '../lib/contract/activity-commands';
import { saveCommands } from './contractSaving';
import { contractWorkBlock, installation, requireContractWork } from './contractPolicy';
import { currentPointer } from './templates';

function buyerCompanyName(value: string) {
	const name = value.trim();
	if (!name) throw new ConvexError('Enter a buyer company name.');
	if (name.length > 200) throw new ConvexError('Company names must be 200 characters or fewer.');
	return name;
}

export function stateOf(contract: Doc<'savedContracts'>) {
	return {
		hubspot: contract.hubspot,
		buyerCompanyName: contract.buyerCompanyName,
		applications: contract.applications,
		editRevision: contract.editRevision,
		reviewGeneration: contract.reviewGeneration,
		reviewCompletion: contract.reviewCompletion ?? null,
		stateVersion: contract.stateVersion,
		lastOperationId: contract.lastOperation?.id ?? null
	};
}

export function metadataOf(contract: Doc<'savedContracts'>) {
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
		const access = await requireMembership(ctx, args.membershipId);
		return readDirectory(ctx, access.companyId, args.search, args.paginationOpts);
	}
});

export const state = query({
	// Like full reads, route IDs may be malformed or refer to deleted contracts.
	args: { membershipId: v.id('memberships'), id: v.string() },
	returns: v.union(contractMetadata, v.null()),
	handler: async (ctx, { id, membershipId }) => {
		const access = await requireMembership(ctx, membershipId);
		const contractId = ctx.db.normalizeId('savedContracts', id);
		const contract = contractId
			? accessibleContract(await ctx.db.get('savedContracts', contractId), access)
			: null;
		return contract
			? { ...metadataOf(contract), workBlock: await contractWorkBlock(ctx, contract) }
			: null;
	}
});

export const create = mutation({
	args: {
		membershipId: v.id('memberships'),
		buyerCompanyName: v.string(),
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
		const receipt = await ctx.db
			.query('contractCreationReceipts')
			.withIndex('by_operationId', (q) =>
				q.eq('operationId', scopedOperation(access, args.operationId))
			)
			.unique();
		if (receipt) {
			const contract = accessibleContract(
				await ctx.db.get('savedContracts', receipt.contractId),
				access
			);
			if (!contract) return { status: 'deleted' as const };
			return { status: 'created' as const, id: receipt.contractId, contract: metadataOf(contract) };
		}
		// Receipt first: this definitive refusal proves this manual attempt never committed.
		if (await installation(ctx, access.companyId))
			return { status: 'association-required' as const };
		const name = buyerCompanyName(args.buyerCompanyName);
		const contract = await createContract(ctx, access, name);
		await ctx.db.insert('contractCreationReceipts', {
			companyId: access.companyId,
			operationId: scopedOperation(access, args.operationId),
			contractId: contract._id
		});
		return { status: 'created' as const, id: contract._id, contract: metadataOf(contract) };
	}
});

export const saveChoices = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('savedContracts'),
		choices: applicationChoices,
		commands: v.optional(v.array(activityCommand)),
		expectedEditRevision: v.number(),
		operationId: v.string()
	},
	returns: saveResult,
	handler: async (
		ctx,
		{ id, membershipId, choices, commands, expectedEditRevision, operationId }
	) => {
		const access = await requireMembership(ctx, membershipId);
		validateOperationId(operationId);
		if (!Number.isSafeInteger(expectedEditRevision) || expectedEditRevision < 0)
			throw new ConvexError('Invalid contract revision.');
		const contract = accessibleContract(await ctx.db.get('savedContracts', id), access);
		if (!contract) return { status: 'deleted' as const };
		if (!commands) {
			// Old snapshot requests may only acknowledge proven accepted work.
			if (
				contract.lastOperation?.id === operationId &&
				contract.lastOperation.callerId === access.profile._id
			)
				return { status: 'saved' as const, state: stateOf(contract) };
			if (contract.editRevision !== expectedEditRevision)
				return { status: 'conflict' as const, state: stateOf(contract) };
			if (sameApplications(choicesOf(contract.applications), choices))
				return { status: 'saved' as const, state: stateOf(contract) };
			throw new ConvexError({
				code: 'SAVE_PROTOCOL_REQUIRED',
				message:
					'Reload to update your contract editor before saving. Your draft is still available.'
			});
		}
		return saveCommands(ctx, access, contract, {
			commands,
			choices,
			expectedEditRevision,
			operationId
		});
	}
});

export const rename = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('savedContracts'),
		buyerCompanyName: v.string()
	},
	returns: v.null(),
	handler: async (ctx, { id, membershipId, buyerCompanyName: value }) => {
		const access = await requireMembership(ctx, membershipId);
		const contract = accessibleContract(await ctx.db.get('savedContracts', id), access);
		if (!contract) throw new ConvexError('This contract was deleted.');
		const name = buyerCompanyName(value);
		if (name === contract.buyerCompanyName) return null;
		await requireContractWork(ctx, contract);
		const savedAt = Date.now();
		await ctx.db.patch('savedContracts', id, {
			buyerCompanyName: name,
			savedAt,
			stateVersion: contract.stateVersion + 1
		});
		await writeDirectory(ctx, { ...contract, buyerCompanyName: name, savedAt });
		return null;
	}
});

export const remove = mutation({
	args: { membershipId: v.id('memberships'), id: v.id('savedContracts') },
	returns: v.null(),
	handler: async (ctx, { id, membershipId }) => {
		const access = await requireMembership(ctx, membershipId);
		const contract = accessibleContract(await ctx.db.get('savedContracts', id), access);
		await ensureContractCleanup(ctx, access.companyId, id, Boolean(contract));
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

export async function createContract(
	ctx: MutationCtx,
	access: CompanyAccess,
	name: string,
	hubspot?: Doc<'savedContracts'>['hubspot']
) {
	await requireContractWork(ctx, { companyId: access.companyId, hubspot });
	const pointer = await currentPointer(ctx, access.companyId);
	const version = pointer?.versionId
		? await ctx.db.get('templateVersions', pointer.versionId)
		: null;
	if (!version || version.companyId !== access.companyId)
		throw new ConvexError('The baseline contract is not available.');
	const id = await ctx.db.insert('savedContracts', {
		companyId: access.companyId,
		buyerCompanyName: name,
		creatorId: access.profile._id,
		savedAt: Date.now(),
		applications: {},
		editRevision: 0,
		reviewGeneration: 0,
		stateVersion: 1,
		templateVersionId: version._id,
		hubspot
	});
	if (version.mutability === 'mutable')
		await ctx.db.patch('templateVersions', version._id, { mutability: 'frozen' as const });
	const contract = (await ctx.db.get('savedContracts', id))!;
	await writeDirectory(ctx, contract);
	return contract;
}
