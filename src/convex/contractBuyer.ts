import type { Doc } from './_generated/dataModel';

/** The buyer organization is contract-scoped; the seller workspace never supplies this name. */
export function buyerName(contract: Pick<Doc<'savedContracts'>, 'title' | 'buyer'>): string | null {
	return contract.buyer.kind === 'manual' ? contract.title : (contract.buyer.company?.name ?? null);
}
