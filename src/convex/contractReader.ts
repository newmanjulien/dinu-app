import { resolveTemplateItem } from '../lib/contract/items';
import { isRepItem } from '../lib/playbook/model';
import type { Doc } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import type { ContractItemId } from '../lib/contract/item-identity';
import { snapshotReader } from './templates';
import { buildSourceIndex } from '../lib/document/source-index';

/** Frozen Playbook content only. Buyer changes are native immutable changes, never fake items. */
export async function contractReader(
	ctx: QueryCtx,
	contract: Pick<Doc<'savedContracts'>, '_id' | 'templateVersionId' | 'companyId'>
) {
	const template = await snapshotReader(ctx, contract);
	const resolved = new Map<ContractItemId, ReturnType<typeof readItem>>();
	async function readItem(id: ContractItemId) {
		const templateId = ctx.db.normalizeId('playbookItems', id);
		if (!templateId) return null;
		const saved = await template.item(templateId);
		return saved && isRepItem(saved)
			? { ...resolveTemplateItem(saved), companyId: saved.companyId }
			: null;
	}
	function item(id: ContractItemId) {
		let pending = resolved.get(id);
		if (!pending) {
			pending = readItem(id);
			resolved.set(id, pending);
		}
		return pending;
	}
	let originalIndex: Promise<ReturnType<typeof buildSourceIndex>> | undefined;
	return {
		originalIndex: () => (originalIndex ??= template.blocks().then(buildSourceIndex)),
		templateItems: async () => (await template.readItems()).filter(isRepItem),
		buyerExplanations: async () =>
			(await template.readItems()).filter(
				(item): item is Extract<typeof item, { audience: 'buyer' }> => !isRepItem(item)
			),
		buyerExplanation: async (id: Doc<'playbookItems'>['_id']) => {
			const saved = await template.item(id);
			return saved && !isRepItem(saved) ? saved : null;
		},
		item
	};
}
