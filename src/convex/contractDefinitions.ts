import { ConvexError, getConvexSize, v } from 'convex/values';
import { query, type QueryCtx } from './_generated/server';
import { seller, type Contract } from './contractState';
import { contractReader } from './contractReader';
import { contractRenderTransport } from './contractValidators';
import { approvedDocument, approvedChain, changeHead, readChange } from './contractChanges';
import {
	contractDocumentToRenderTransport,
	mapDocumentTarget,
	documentMapping
} from '../lib/document/contract-document';
import { sourceTarget } from '../lib/document/source-validators';
import { resolveTemplateItem } from '../lib/contract/items';
import { hiddenAnnotations } from './contractAnnotations';
import { readContractDocument } from './contractDocuments';
import type { buyerCurrentView } from './buyerValidators';
import type { Infer } from 'convex/values';

const sellerArgs = { membershipId: v.id('memberships'), id: v.id('savedContracts') };
export { displayIdentity } from './contractDisplay';
import { displayIdentity } from './contractDisplay';
/** Shared materialization; public callers provide their authorized small current-view pointer. */
export async function currentDocumentMaterialization(
	ctx: QueryCtx,
	contract: {
		root: Pick<
			Contract['root'],
			'_id' | 'companyId' | 'documentId' | 'documentRevision' | 'title' | 'templateVersionId'
		>;
	},
	currentView?: Infer<typeof buyerCurrentView>
) {
	const document = currentView
		? await readContractDocument(
				ctx,
				contract.root.documentId,
				{ companyId: contract.root.companyId, contractId: contract.root._id },
				{ currentView }
			)
		: await approvedDocument(ctx, contract);
	const manifest = await ctx.db.get('contractDocuments', contract.root.documentId);
	if (
		!manifest ||
		manifest.contractId !== contract.root._id ||
		manifest.companyId !== contract.root.companyId
	)
		throw new Error('Invalid current document ownership.');
	return {
		document,
		transport: contractDocumentToRenderTransport(document),
		displayIdentity: displayIdentity(contract.root, manifest.fingerprint)
	};
}
export async function currentSnapshot(ctx: QueryCtx, contract: Contract) {
	const reader = await contractReader(ctx, contract.root),
		current = await currentDocumentMaterialization(ctx, contract);
	const hiddenItemIds = await hiddenAnnotations(ctx, contract, current.document, reader);
	const projectedTargets = [],
		mapping = documentMapping(current.document);
	for (const item of (await reader.templateItems()).map(resolveTemplateItem)) {
		if (hiddenItemIds.includes(item._id)) continue;
		try {
			projectedTargets.push({
				itemId: item._id,
				trigger: mapDocumentTarget(current.document, item.primary.target, true, mapping),
				choices: item.choices.map((choice) => ({
					id: choice.id,
					targets: choice.changes.map((change) =>
						mapDocumentTarget(current.document, change.target, true, mapping)
					)
				}))
			});
		} catch {
			hiddenItemIds.push(item._id);
		}
	}
	return { ...current, hiddenItemIds, projectedTargets };
}
export const current = query({
	args: sellerArgs,
	returns: v.object({
		document: contractRenderTransport,
		documentId: v.id('contractDocuments'),
		documentRevision: v.number(),
		displayIdentity: v.string(),
		hiddenItemIds: v.array(v.string()),
		projectedTargets: v.array(
			v.object({
				itemId: v.id('playbookItems'),
				trigger: sourceTarget,
				choices: v.array(v.object({ id: v.string(), targets: v.array(sourceTarget) }))
			})
		)
	}),
	handler: async (ctx, args) => {
		const { contract } = await seller(ctx, args),
			result = await currentSnapshot(ctx, contract);
		const payload = {
			document: result.transport,
			documentId: contract.root.documentId,
			documentRevision: contract.root.documentRevision,
			displayIdentity: result.displayIdentity,
			hiddenItemIds: result.hiddenItemIds,
			projectedTargets: result.projectedTargets
		};
		if (getConvexSize(payload) > 15_000_000)
			throw new ConvexError('The current contract exceeds supported response capacity.');
		return payload;
	}
});
/** One focused basis; local option switching reuses it without composing pending alternatives. */
export const previewBasis = query({
	args: { ...sellerArgs, itemId: v.id('playbookItems') },
	returns: v.object({
		documentId: v.id('contractDocuments'),
		documentRevision: v.number(),
		displayIdentity: v.string(),
		currentChangeId: v.union(v.id('contractChanges'), v.null()),
		appliedChangeId: v.union(v.id('contractChanges'), v.null()),
		approvedChain: v.string(),
		currentPatch: v.union(v.string(), v.null())
	}),
	handler: async (ctx, args) => {
		const { contract } = await seller(ctx, args);
		if (!(await (await contractReader(ctx, contract.root)).item(args.itemId)))
			throw new ConvexError('This Playbook option is unavailable.');
		const selected = await changeHead(ctx, contract, 'playbook', args.itemId);
		const chain = await approvedChain(ctx, contract, selected?.head.appliedChangeId);
		const manifest = await ctx.db.get('contractDocuments', contract.root.documentId);
		if (
			!manifest ||
			manifest.contractId !== contract.root._id ||
			manifest.companyId !== contract.root.companyId
		)
			throw new Error('Invalid current document.');
		const payload = {
			documentId: contract.root.documentId,
			documentRevision: contract.root.documentRevision,
			displayIdentity: displayIdentity(contract.root, manifest.fingerprint),
			currentChangeId: selected?.head.currentChangeId ?? null,
			appliedChangeId: selected?.head.appliedChangeId ?? null,
			approvedChain: JSON.stringify(chain),
			currentPatch:
				selected?.current && selected.current._id !== selected.applied?._id
					? JSON.stringify((await readChange(ctx, selected.current._id, contract)).patch)
					: null
		};
		if (getConvexSize(payload) > 15_000_000)
			throw new ConvexError('This widget preview exceeds supported response capacity.');
		return payload;
	}
});
