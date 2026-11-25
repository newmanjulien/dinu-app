import type { Infer } from 'convex/values';
import { ConvexError } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { accessibleContract, requireMembership, type CompanyAccess } from './auth';
import { hubspotLink } from './hubspotValidators';
import { writeDirectory } from './contractDirectory';
import { canonicalJson } from '../lib/document/canonical-json';
import { syncBuyerLinkMetadata } from './buyerLinks';

export type ContractHubspotLink = Infer<typeof hubspotLink>;

/** The root owns business state; the association is independent provider state. */
export type Contract = {
	root: Doc<'savedContracts'>;
	hubspot?: ContractHubspotLink;
	hubspotAssociationId: Id<'contractHubspotAssociations'> | null;
};

export async function readContract(ctx: QueryCtx, root: Doc<'savedContracts'>): Promise<Contract> {
	const association = await ctx.db
		.query('contractHubspotAssociations')
		.withIndex('by_contractId', (q) => q.eq('contractId', root._id))
		.unique();
	if (association && association.companyId !== root.companyId)
		throw new Error('Contract association ownership is invalid.');
	return {
		root,
		hubspot: association
			? {
					connectionId: association.connectionId,
					accountId: association.accountId,
					dealId: association.dealId,
					generation: association.generation,
					availability: association.availability
				}
			: undefined,
		hubspotAssociationId: association?._id ?? null
	};
}

export async function accessibleContractState(
	ctx: QueryCtx,
	id: Id<'savedContracts'>,
	access: CompanyAccess
) {
	const root = accessibleContract(await ctx.db.get('savedContracts', id), access);
	return root ? readContract(ctx, root) : null;
}

/** Generic seller authorization belongs to the contract domain, independent of buyer links. */
export async function seller(
	ctx: QueryCtx,
	args: { membershipId: Id<'memberships'>; id: Id<'savedContracts'> }
) {
	const access = await requireMembership(ctx, args.membershipId);
	const contract = await accessibleContractState(ctx, args.id, access);
	if (!contract) throw new ConvexError('This contract is unavailable.');
	return { access, contract };
}

export async function hasOtherHubspotAssociation(
	ctx: QueryCtx,
	companyId: Id<'company'>,
	link: Pick<ContractHubspotLink, 'connectionId' | 'dealId'>,
	contractId?: Id<'savedContracts'>
) {
	const owners = await ctx.db
		.query('contractHubspotAssociations')
		.withIndex('by_companyId_and_connectionId_and_dealId', (q) =>
			q.eq('companyId', companyId).eq('connectionId', link.connectionId).eq('dealId', link.dealId)
		)
		.take(2);
	return owners.some((owner) => owner.contractId !== contractId);
}

export async function assertHubspotAssociationAvailable(
	ctx: QueryCtx,
	companyId: Id<'company'>,
	contractId: Id<'savedContracts'>,
	link: ContractHubspotLink
) {
	if (await hasOtherHubspotAssociation(ctx, companyId, link, contractId))
		throw new ConvexError({
			code: 'hubspot-deal-already-linked',
			message: 'This deal is already linked to another contract.'
		});
}

type ContractChanges = Partial<
	Omit<
		Doc<'savedContracts'>,
		'_id' | '_creationTime' | 'companyId' | 'creatorId' | 'templateVersionId' | 'metadataRevision'
	>
> & {
	hubspot?: ContractHubspotLink;
};

/** One root write and only changed listing/link metadata fields. */
export async function patchContract(
	ctx: MutationCtx,
	contract: Contract,
	changes: ContractChanges,
	options: {
		hasUnreadComment?: boolean;
		directoryRow?: Doc<'contractDirectory'>;
	} = {}
): Promise<Contract> {
	const { hubspot, ...fields } = changes;
	const rootChanges = Object.fromEntries(
		Object.entries(fields).filter(
			([key, value]) =>
				canonicalJson(value ?? null) !==
				canonicalJson(contract.root[key as keyof Doc<'savedContracts'>] ?? null)
		)
	) as typeof fields;
	const associationChanged =
		'hubspot' in changes &&
		canonicalJson(hubspot ?? null) !== canonicalJson(contract.hubspot ?? null);
	if (associationChanged || fields.buyer?.kind === 'manual')
		await clearBuyerRefresh(ctx, contract.root.companyId, contract.root._id);
	if (associationChanged) {
		if (hubspot) {
			await assertHubspotAssociationAvailable(
				ctx,
				contract.root.companyId,
				contract.root._id,
				hubspot
			);
			const value = {
				companyId: contract.root.companyId,
				contractId: contract.root._id,
				...hubspot
			};
			if (contract.hubspotAssociationId)
				await ctx.db.replace('contractHubspotAssociations', contract.hubspotAssociationId, value);
			else
				contract.hubspotAssociationId = await ctx.db.insert('contractHubspotAssociations', value);
		} else if (contract.hubspotAssociationId) {
			await ctx.db.delete('contractHubspotAssociations', contract.hubspotAssociationId);
			contract.hubspotAssociationId = null;
		}
		contract.hubspot = hubspot;
	}
	if (Object.keys(rootChanges).length || associationChanged) {
		const nextRootChanges = {
			...rootChanges,
			metadataRevision: contract.root.metadataRevision + 1
		};
		await ctx.db.patch('savedContracts', contract.root._id, nextRootChanges);
		contract.root = { ...contract.root, ...nextRootChanges };
	}
	if ('title' in rootChanges || 'buyer' in rootChanges)
		await syncBuyerLinkMetadata(ctx, contract.root);
	if (
		associationChanged ||
		'title' in rootChanges ||
		'savedAt' in rootChanges ||
		options.hasUnreadComment !== undefined
	)
		await writeDirectory(ctx, contract, options);
	return contract;
}

/** Mutation-only lifecycle hook; stable contract reads never depend on refresh bookkeeping. */
export async function clearBuyerRefresh(
	ctx: MutationCtx,
	companyId: Id<'company'>,
	contractId: Id<'savedContracts'>
) {
	const row = await ctx.db
		.query('contractBuyerRefreshes')
		.withIndex('by_contractId', (q) => q.eq('contractId', contractId))
		.unique();
	if (row) {
		if (row.companyId !== companyId) throw new Error('Invalid buyer refresh ownership.');
		await ctx.db.delete('contractBuyerRefreshes', row._id);
	}
}
