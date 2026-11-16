import { buyerName } from './contractBuyer';
import { requestBuyerRefresh } from './hubspotRecipients';
import { assertStorageCapacity } from './storageCapacity';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import { validate } from 'convex-helpers/validators';
import { discussionCommand, seenMessages } from '../lib/discussions/validators';
import { discussionContext } from './discussionContext';
import { discussionActor } from './discussionService';
import { discussionResult, discussionSeenResult } from './discussionCommands';

import { mutation, query, type MutationCtx } from './_generated/server';
import { accessibleContract, requireMembership, scopedOperation, type CompanyAccess } from './auth';
import { ensureContractCleanup } from './contractCleanup';
import { readDirectory, writeDirectory } from './contractDirectory';
import {
	contractCard,
	contractMetadata,
	liveContractMetadata,
	saveResult
} from './savedContractValidators';
import {
	playbookCommand,
	readiness as readinessResult,
	type PlaybookState
} from '../lib/contract/changes';
import { playbookStates, contractReadiness } from './reviews';
import { saveCommands } from './contractSaving';
import { nativePreparationKind } from './discussionPreparationValidators';
import { nativeOperationKey } from './discussionPreparation';
import { receiptPayload, admitOperation } from './operationReceipts';
import { contractWorkBlock, installation, requireContractWork } from './contractPolicy';
import { currentPointer, versionReader } from './templates';
import { createContractDocument } from '../lib/document/contract-document';
import { writeContractDocument } from './contractDocuments';
import { initialContextIdentity } from './contractReviewIdentity';
import {
	accessibleContractState,
	clearBuyerRefresh,
	readContract,
	patchContract,
	assertHubspotAssociationAvailable,
	type Contract,
	type ContractHubspotLink
} from './contractState';

function contractTitle(value: string) {
	const name = value.trim();
	if (!name) throw new ConvexError('Enter a contract name.');
	if (name.length > 200) throw new ConvexError('Contract names must be 200 characters or fewer.');
	return name;
}

export async function stateOf(
	ctx: import('./_generated/server').QueryCtx,
	contract: Contract,
	playbook?: PlaybookState[]
) {
	return {
		title: contract.root.title,
		documentId: contract.root.documentId,
		documentRevision: contract.root.documentRevision,
		stateRevision: contract.root.stateRevision,
		reviews: contract.root.reviews,
		playbook: playbook ?? (await playbookStates(ctx, contract)),
		hubspot: contract.hubspot,
		lastOperationId: contract.root.lastOperation?.id ?? null
	};
}
export async function metadataOf(ctx: import('./_generated/server').QueryCtx, contract: Contract) {
	return {
		...(await stateOf(ctx, contract)),
		_id: contract.root._id,
		_creationTime: contract.root._creationTime,
		companyId: contract.root.companyId,
		creatorId: contract.root.creatorId,
		templateVersionId: contract.root.templateVersionId,
		savedAt: contract.root.savedAt
	};
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
	// Like full reads, route IDs may be malformed or refer to deleted contracts.
	args: {
		membershipId: v.id('memberships'),
		id: v.string()
	},
	returns: v.union(liveContractMetadata, v.null()),
	handler: async (ctx, { id, membershipId }) => {
		const access = await requireMembership(ctx, membershipId);
		const contractId = ctx.db.normalizeId('savedContracts', id);
		const contract = contractId ? await accessibleContractState(ctx, contractId, access) : null;
		return contract
			? {
					...(await metadataOf(ctx, contract)),
					buyerName: buyerName(contract.root),
					workBlock: await contractWorkBlock(ctx, contract)
				}
			: null;
	}
});

export const readiness = query({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('savedContracts'),
		paginationOpts: v.optional(paginationOptsValidator)
	},
	returns: v.union(readinessResult, v.null()),
	handler: async (ctx, { id, membershipId, paginationOpts }) => {
		const access = await requireMembership(ctx, membershipId);
		const contract = await accessibleContractState(ctx, id, access);
		if (!contract) return null;
		const result = await contractReadiness(ctx, contract, paginationOpts),
			workBlock = await contractWorkBlock(ctx, contract);
		return { ...result, ready: result.ready && workBlock === null, workBlock };
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
		const { retryUntil, gcAfter } = admitOperation(args.operationId),
			inputs = JSON.stringify([args.title]);
		const receipt = await ctx.db
			.query('contractCreationReceipts')
			.withIndex('by_operationId', (q) =>
				q.eq('operationId', scopedOperation(access, args.operationId))
			)
			.unique();
		if (receipt) {
			if (receipt.inputs !== inputs)
				throw new ConvexError('This operation was already used with different inputs.');
			const contract = await accessibleContractState(ctx, receipt.contractId, access);
			if (!contract) return { status: 'deleted' as const };
			return {
				status: 'created' as const,
				id: receipt.contractId,
				contract: await metadataOf(ctx, contract)
			};
		}
		// Receipt first: this definitive refusal proves this manual attempt never committed.
		if (await installation(ctx, access.companyId))
			return { status: 'association-required' as const };
		const name = contractTitle(args.title);
		const contract = await createContract(ctx, access, name);
		await ctx.db.insert('contractCreationReceipts', {
			retryUntil,
			gcAfter,
			inputs,
			companyId: access.companyId,
			operationId: scopedOperation(access, args.operationId),
			contractId: contract.root._id
		});
		return {
			status: 'created' as const,
			id: contract.root._id,
			contract: await metadataOf(ctx, contract)
		};
	}
});

export const saveChanges = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('savedContracts'),
		commands: v.array(playbookCommand),
		operationId: v.string()
	},
	returns: saveResult,
	handler: async (ctx, { id, membershipId, commands, operationId }) => {
		const access = await requireMembership(ctx, membershipId);
		admitOperation(operationId);
		for (const command of commands) admitOperation(command.id);
		const contract = await accessibleContractState(ctx, id, access);
		if (!contract) return { status: 'deleted' as const };
		return saveCommands(ctx, access, contract, {
			commands,
			operationId
		});
	}
});

/** Exceptional preparation result transport. Ordinary saves still return their result directly. */
export const operationResult = query({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('savedContracts'),
		kind: nativePreparationKind,
		operationId: v.string(),
		inputs: v.string()
	},
	returns: v.union(
		v.null(),
		v.object({ status: v.literal('preparing'), operationId: v.string(), retryUntil: v.number() }),
		v.object({
			status: v.literal('complete'),
			operationId: v.string(),
			retryUntil: v.number(),
			result: v.string()
		}),
		v.object({
			status: v.literal('failed'),
			operationId: v.string(),
			retryUntil: v.number(),
			error: v.string(),
			errorCode: v.optional(v.literal('OPERATION_EXPIRED'))
		})
	),
	handler: async (ctx, { membershipId, id, kind, operationId, inputs }) => {
		const access = await requireMembership(ctx, membershipId);
		const contract = await accessibleContractState(ctx, id, access);
		if (!contract) throw new ConvexError('This contract is unavailable.');
		const deletion = await ctx.db
			.query('contractCleanups')
			.withIndex('by_contractId', (q) => q.eq('contractId', id))
			.unique();
		if (deletion) throw new ConvexError('This contract is unavailable.');
		// Small discussion writes use their bounded discussion receipt. Reattachment
		// must consult it even when no exceptional preparation receipt was allocated.
		if (kind === 'discussion-write' || kind === 'discussion-mark-seen') {
			const input: unknown = JSON.parse(inputs),
				common = { token: v.string(), operationId: v.string() };
			const valid =
				kind === 'discussion-write'
					? validate(v.object({ ...common, command: discussionCommand }), input)
					: validate(v.object({ ...common, messages: seenMessages }), input);
			if (
				!valid ||
				!input ||
				typeof input !== 'object' ||
				!('token' in input) ||
				typeof input.token !== 'string' ||
				!('operationId' in input) ||
				input.operationId !== operationId
			)
				throw new ConvexError('Invalid original discussion result input.');
			const context = await discussionContext(ctx, { token: input.token });
			if (context.root._id !== id || context.root.companyId !== access.companyId)
				throw new ConvexError('This operation is unavailable.');
			const actor = await discussionActor(ctx, context);
			if (
				kind === 'discussion-write' &&
				validate(v.object({ ...common, command: discussionCommand }), input)
			)
				return discussionResult(ctx, context, actor, input);
			if (
				kind === 'discussion-mark-seen' &&
				validate(v.object({ ...common, messages: seenMessages }), input)
			)
				return discussionSeenResult(ctx, context, actor, input);
			throw new ConvexError('Invalid original discussion result input.');
		}
		const row = await ctx.db
			.query('operationReceipts')
			.withIndex('by_key', (q) => q.eq('key', nativeOperationKey(access, kind, operationId)))
			.unique();
		if (!row) return null;
		if (row.companyId !== access.companyId || row.contractId !== id || row.kind !== kind)
			throw new ConvexError('This operation is unavailable.');
		const payload = await receiptPayload(ctx, row);
		if (payload.inputs !== inputs)
			throw new ConvexError('This operation was already used with different inputs.');
		if (row.actor) {
			if (
				row.actor.kind !== 'seller' ||
				row.actor.membershipId !== access.membershipId ||
				row.actor.profileId !== access.profile._id ||
				row.actor.identity !== access.profile.identity
			)
				throw new ConvexError('This operation is unavailable.');
			if (row.actor.link) {
				const link = await ctx.db.get('buyerLinks', row.actor.link.id);
				if (
					!link?.currentView ||
					link.companyId !== access.companyId ||
					link.contractId !== id ||
					link.token !== row.actor.link.token
				)
					throw new ConvexError('This link is unavailable.');
			}
		}
		if (row.state === 'preparing')
			return { status: 'preparing' as const, operationId, retryUntil: row.retryUntil };
		if (row.state === 'failed')
			return {
				status: 'failed' as const,
				operationId,
				retryUntil: row.retryUntil,
				errorCode: row.errorCode,
				error: row.error ?? 'This operation could not complete.'
			};
		return {
			status: 'complete' as const,
			operationId,
			retryUntil: row.retryUntil,
			result: payload.result
		};
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
		const savedAt = Date.now();
		await patchContract(ctx, contract, {
			title: name,
			...(!(await installation(ctx, access.companyId))
				? { buyer: { kind: 'manual' as const } }
				: {}),
			savedAt,
			stateRevision: contract.root.stateRevision + 1
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
		const request = await ctx.db
			.query('approvalRequests')
			.withIndex('by_contractId', (q) => q.eq('contractId', id))
			.take(2);
		for (const row of request) await ctx.db.delete('approvalRequests', row._id);
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
	await assertStorageCapacity(ctx, { documents: 5, bytes: 20_000 });
	const id = await ctx.db.insert('savedContracts', {
		companyId: access.companyId,
		title: name,
		buyer: hubspot ? { kind: 'hubspot', company: null } : { kind: 'manual' },
		creatorId: access.profile._id,
		templateVersionId: version._id,
		documentId: null,
		documentRevision: 0,
		stateRevision: 1,
		playbookSelectionCount: 0,
		playbookReviewCount: 0,
		playbookPendingCount: 0,
		playbookDeclinedCount: 0,
		reviews: { playbook: { identity: '' }, buyerLink: { identity: '' } },
		savedAt: Date.now()
	});
	const document = createContractDocument(
		await (await versionReader(ctx, version._id, access.companyId)).blocks()
	);
	const documentId = await writeContractDocument(ctx, {
		companyId: access.companyId,
		contractId: id,
		document
	});
	// The only second root write completes cyclic ownership before any receipt or return.
	await ctx.db.patch('savedContracts', id, {
		documentId,
		reviews: {
			playbook: { identity: initialContextIdentity(id, 'playbook') },
			buyerLink: { identity: initialContextIdentity(id, 'buyer-link') }
		}
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
	if (hubspot) await requestBuyerRefresh(ctx, contract.root);
	return contract;
}
