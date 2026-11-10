import { ConvexError, getConvexSize, type Infer } from 'convex/values';
import { releasedRecord } from '../lib/contract/released-selections';
import type { Doc } from './_generated/dataModel';
import type { contractItem } from './contractItemValidators';

export function buyerItem(item: Infer<typeof contractItem>, choice?: string) {
	return {
		itemId: item._id,
		trigger: item.trigger,
		concessions: item.concessions
			.filter((c) => c.id === choice)
			.map(({ id, changes }) => ({ id, changes }))
	};
}
export function publicProjection(
	state: Pick<Doc<'contractBuyerState'>, 'title' | 'buyerRevision' | 'selections'>,
	items: readonly Infer<typeof contractItem>[]
) {
	const selection = releasedRecord(state.selections);
	const result = {
		title: state.title,
		buyerRevision: state.buyerRevision,
		selections: state.selections,
		items: items.map((item) => buyerItem(item, selection[item._id]))
	};
	if (getConvexSize(result) > 4_000_000)
		throw new ConvexError('This publication exceeds supported response capacity.');
	return result;
}

export function buyerExplanation(item: import('./playbookItemRevisions').HistoricalItem) {
	if (!('audience' in item)) throw new Error('Expected a buyer explanation');
	return { itemId: item._id, trigger: item.trigger, explanation: item.explanation };
}
