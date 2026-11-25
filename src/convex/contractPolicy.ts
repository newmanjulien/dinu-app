import { patchContract, type Contract, type ContractHubspotLink } from './contractState';
import { ConvexError } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { workBlockMessage, type ContractWorkBlock } from '../lib/contract/work-policy';
import { blockLink } from './hubspotRecords';
import { installation } from './hubspotInstallation';
export { installation } from './hubspotInstallation';

export async function contractWorkBlock(
	ctx: QueryCtx,
	contract: { root: { companyId: Doc<'company'>['_id'] }; hubspot?: ContractHubspotLink }
): Promise<ContractWorkBlock | null> {
	const connection = await installation(ctx, contract.root.companyId);
	return blockForConnection(connection, contract.hubspot);
}

export function blockForConnection(
	connection: Pick<Doc<'hubspotConnections'>, '_id' | 'accountId'> | null,
	link: ContractHubspotLink | undefined
): ContractWorkBlock | null {
	if (!connection) return null;
	if (!link || link.connectionId !== connection._id || link.accountId !== connection.accountId)
		return 'association-required';
	return link.availability === 'unavailable' ? 'deal-unavailable' : null;
}

export async function requireContractWork(
	ctx: QueryCtx,
	contract: { root: { companyId: Doc<'company'>['_id'] }; hubspot?: ContractHubspotLink }
) {
	const connection = await installation(ctx, contract.root.companyId);
	const block = blockForConnection(connection, contract.hubspot);
	if (block) throw new ConvexError({ code: block, message: workBlockMessage(block) });
	return connection;
}

/** Callers fence provider evidence before marking the current matching destination. */
export async function markDealUnavailable(ctx: MutationCtx, contract: Contract) {
	if (!contract.hubspot) return;
	await blockLink(ctx, contract.root.companyId, contract.root._id, contract.hubspot.generation);
	if (contract.hubspot.availability === 'unavailable') return;
	await patchContract(ctx, contract, {
		hubspot: { ...contract.hubspot, availability: 'unavailable' as const }
	});
}
