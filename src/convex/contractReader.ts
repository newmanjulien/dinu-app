import { isRepItem } from '../lib/playbook/model';
import { ConvexError, getConvexSize, type Infer } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import type { ContractItemId } from '../lib/contract/item-identity';
import type { contractItem } from './contractItemValidators';
import type { selections } from './contractValidators';
import { snapshotReader } from './templates';
import { MAX_STORAGE_DOCUMENT_BYTES } from '../lib/document/storage-limits';
import { MAX_RELEASED_SELECTIONS } from '../lib/contract/released-selections';
import { CompiledDocument } from '../lib/document/compiled-document';
import { MAX_SELECTED_CONCESSIONS } from '../lib/document/selection-limits';

/** Contract alternatives never enter the company template or mutable playbook. */
export async function contractReader(
	ctx: QueryCtx,
	contract: Pick<Doc<'savedContracts'>, '_id' | 'templateVersionId' | 'companyId'>
) {
	const template = await snapshotReader(ctx, contract);
	let localReads = Promise.resolve();
	let localBytes = 0;
	const resolved = new Map<ContractItemId, Promise<Infer<typeof contractItem> | null>>();
	function item(id: ContractItemId) {
		let pending = resolved.get(id);
		if (!pending) {
			pending = (async () => {
				const localId = ctx.db.normalizeId('contractConcessions', id);
				if (!localId) {
					const saved = await template.item(id as Doc<'playbookItems'>['_id']);
					return saved && isRepItem(saved) ? saved : null;
				}
				const read = localReads.then(async () => {
					const metrics = await ctx.meta.getTransactionMetrics();
					if (metrics.bytesRead.remaining < 600_000 || metrics.databaseQueries.remaining < 2)
						throw new ConvexError(
							'This contract’s custom wording exceeds supported read capacity.'
						);
					const local = await ctx.db.get('contractConcessions', localId);
					if (!local || local.contractId !== contract._id || local.companyId !== contract.companyId)
						return null;
					localBytes += getConvexSize(local);
					if (localBytes > 2_000_000)
						throw new ConvexError('This contract has too much custom wording to load safely.');
					const { contractId: _contractId, proposalId: _proposalId, ...definition } = local;
					return definition;
				});
				localReads = read.then(
					() => undefined,
					() => undefined
				);
				return read;
			})();
			resolved.set(id, pending);
		}
		return pending;
	}
	/** Public content contains the immutable template plus released local alternatives. */
	async function publicItem(id: ContractItemId, selection: Infer<typeof selections>) {
		const choice = selection[id];
		if (ctx.db.normalizeId('contractConcessions', id) && choice === undefined) return null;
		const row = await item(id);
		if (!row || (choice !== undefined && !row.concessions.some((c) => c.id === choice)))
			return null;
		return row;
	}
	async function selectedItems(
		selection: Infer<typeof selections>,
		unavailableMessage = 'A selected concession does not belong to this contract.',
		limit = MAX_SELECTED_CONCESSIONS
	) {
		const ids = Object.keys(selection) as ContractItemId[];
		if (ids.length > limit) throw new ConvexError('Too many selected concessions.');
		const result: Infer<typeof contractItem>[] = [];
		for (let offset = 0; offset < ids.length; offset += 32) {
			const batch = ids.slice(offset, offset + 32);
			const rows = await Promise.all(batch.map((id) => publicItem(id, selection)));
			for (const row of rows) {
				if (!row) throw new ConvexError(unavailableMessage);
				result.push(row);
			}
		}
		return result;
	}
	let blockRead: ReturnType<typeof template.blocks> | undefined;
	let compilation: Promise<CompiledDocument> | undefined;
	const blocks = () => (blockRead ??= template.blocks());
	return {
		contractId: contract._id,
		validatePublicationRead(items: readonly Infer<typeof contractItem>[], stateBytes: number) {
			const localBytes = items.reduce(
				(sum, row) =>
					sum + (ctx.db.normalizeId('contractConcessions', row._id) ? getConvexSize(row) + 256 : 0),
				0
			);
			// Native revision/chunk bytes include all template content. Reserve bounded
			// company/source documents and access metadata, plus the actual state row.
			if (
				template.readBytes + localBytes + stateBytes + 2 * MAX_STORAGE_DOCUMENT_BYTES + 65_536 >
				16 * 1024 * 1024
			)
				throw new ConvexError('This publication exceeds supported read capacity.');
		},
		blocks,
		compiled: () => (compilation ??= blocks().then((rows) => new CompiledDocument(rows))),
		templateItems: async () => (await template.readItems()).filter(isRepItem),
		buyerExplanations: async () => (await template.readItems()).filter((item) => !isRepItem(item)),
		buyerExplanation: async (id: Doc<'playbookItems'>['_id']) => {
			const saved = await template.item(id);
			return saved && !isRepItem(saved) ? saved : null;
		},
		item,
		publicItem,
		selectedItems,
		releasedItems: (selection: Infer<typeof selections>) =>
			selectedItems(selection, undefined, MAX_RELEASED_SELECTIONS)
	};
}
