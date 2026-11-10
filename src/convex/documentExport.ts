import { ConvexError } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { contractReader } from './contractReader';
import { concessionSelections } from '../lib/contract/applications';
import { savedReviews } from '../lib/contract/approval';

/** Shared saved-version approval boundary for Word and native Quotes. */
export async function approvedExport(
	ctx: QueryCtx,
	contract: Doc<'savedContracts'>,
	purpose = 'exporting',
	unavailableMessage?: string,
	prepared?: Awaited<ReturnType<typeof contractReader>>
) {
	const reader = prepared ?? (await contractReader(ctx, contract));
	if (reader.contractId !== contract._id) throw new Error('Invalid contract preparation.');
	const items = await reader.selectedItems(
		concessionSelections(contract.applications),
		unavailableMessage
	);
	const reviews = savedReviews(items, contract);
	if (reviews.some((review) => review.status !== 'approved'))
		throw new ConvexError(`All selected concessions must be approved before ${purpose}.`);
	return { reader, items, reviews };
}
