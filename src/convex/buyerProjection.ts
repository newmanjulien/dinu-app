import {
	documentMapping,
	mapDocumentTarget,
	type ContractDocument
} from '../lib/document/contract-document';
import type { SourceTarget } from '../lib/document/source-model';

function buyerExplanation(item: import('./playbookItemRevisions').HistoricalItem) {
	if (!('audience' in item)) throw new Error('Expected a buyer explanation');
	return { itemId: item._id, trigger: item.trigger, explanation: item.explanation };
}

export function materializedBuyerExplanations(
	items: readonly import('./playbookItemRevisions').HistoricalItem[],
	document: ContractDocument
) {
	const mapping = documentMapping(document);
	return items.flatMap((item) => {
		try {
			const explanation = buyerExplanation(item);
			return [
				{
					...explanation,
					trigger: {
						...explanation.trigger,
						target: mapDocumentTarget(document, explanation.trigger.target, true, mapping)
					}
				}
			];
		} catch {
			return [];
		}
	});
}

/** Approved footprints come from immutable lineage, without exposing native private
 * change IDs, decisions, selectable alternatives or replacement payloads. */
export function materializedBuyerAnnotations(
	document: ContractDocument
): { target: SourceTarget }[] {
	const footprints: { target: SourceTarget }[] = [];
	const byKey = new Map(document.pieces.map((piece) => [piece.sourceKey, piece]));
	for (const block of document.blocks) {
		if (block.kind === 'table') continue;
		for (const atom of block.content) {
			const piece = byKey.get(atom.sourceKey);
			if (!piece?.annotationKind || !piece.createdBy) continue;
			const end = atom.kind === 'text' ? atom.text.length : 1;
			footprints.push({
				target: {
					kind: 'text',
					range: {
						start: { sourceKey: atom.sourceKey, offset: 0 },
						end: { sourceKey: atom.sourceKey, offset: end }
					}
				}
			});
		}
	}
	const blocks = new Set(document.blocks.map((block) => block.blockKey));
	const boundaries = new Set(
		(document.annotationEffects ?? []).flatMap((effect) => effect.structuralBlocks)
	);
	for (const afterBlockKey of boundaries)
		if (blocks.has(afterBlockKey)) footprints.push({ target: { kind: 'boundary', afterBlockKey } });
	return footprints;
}

export function buyerAnnotationGroups(document: ContractDocument) {
	const annotations = materializedBuyerAnnotations(document);
	const groups = [];
	for (let offset = 0; offset < annotations.length; offset += 4096)
		groups.push(annotations.slice(offset, offset + 4096));
	return groups;
}
