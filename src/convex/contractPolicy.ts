import { ConvexError } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { workBlockMessage, type ContractWorkBlock } from '../lib/contract/work-policy';
import { blockLink } from './hubspotRecords';
import { writeDirectory } from './contractDirectory';

export function installation(ctx: QueryCtx, companyId: Id<'company'>) {
	return ctx.db
		.query('hubspotConnections')
		.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
		.unique();
}

export async function contractWorkBlock(
	ctx: QueryCtx,
	contract: Pick<Doc<'savedContracts'>, 'companyId' | 'hubspot'>
): Promise<ContractWorkBlock | null> {
	const connection = await installation(ctx, contract.companyId);
	return blockForConnection(connection, contract.hubspot);
}

export function blockForConnection(
	connection: Pick<Doc<'hubspotConnections'>, '_id' | 'accountId'> | null,
	link: Doc<'savedContracts'>['hubspot']
): ContractWorkBlock | null {
	if (!connection) return null;
	if (!link || link.connectionId !== connection._id || link.accountId !== connection.accountId)
		return 'association-required';
	return link.availability === 'unavailable' ? 'deal-unavailable' : null;
}

export async function requireContractWork(
	ctx: QueryCtx,
	contract: Pick<Doc<'savedContracts'>, 'companyId' | 'hubspot'>
) {
	const block = await contractWorkBlock(ctx, contract);
	if (block) throw new ConvexError({ code: block, message: workBlockMessage(block) });
}

/** Callers fence provider evidence before marking the current matching destination. */
export async function markDealUnavailable(ctx: MutationCtx, contract: Doc<'savedContracts'>) {
	if (!contract.hubspot) return;
	await blockLink(ctx, contract.companyId, contract._id, contract.hubspot.generation);
	if (contract.hubspot.availability === 'unavailable') return;
	const changes = {
		hubspot: { ...contract.hubspot, availability: 'unavailable' as const },
		stateVersion: contract.stateVersion + 1
	};
	await ctx.db.patch('savedContracts', contract._id, changes);
	await writeDirectory(ctx, { ...contract, ...changes });
}
