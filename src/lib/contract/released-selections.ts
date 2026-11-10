import { ConvexError, v, type Infer } from 'convex/values';
import { contractItemId, type ContractItemId } from './item-identity';
export const MAX_RELEASED_SELECTIONS = 8192;
export const releasedSelections = v.array(
	v.object({ itemId: contractItemId, concessionId: v.string() })
);
export function releasedRecord(
	entries: Infer<typeof releasedSelections>
): Record<ContractItemId, string> {
	if (
		entries.length > MAX_RELEASED_SELECTIONS ||
		new Set(entries.map((e) => e.itemId)).size !== entries.length
	)
		throw new ConvexError('This publication exceeds supported selection capacity.');
	return Object.fromEntries(entries.map((e) => [e.itemId, e.concessionId]));
}
export function releasedEntries(record: Readonly<Record<ContractItemId, string>>) {
	const entries = Object.entries(record).map(([itemId, concessionId]) => ({
		itemId: itemId as ContractItemId,
		concessionId
	}));
	if (entries.length > MAX_RELEASED_SELECTIONS)
		throw new ConvexError('This publication exceeds supported selection capacity.');
	return entries;
}
