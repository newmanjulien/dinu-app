import type { QueryCtx } from './_generated/server';
import type { Contract } from './contractState';
import type { contractReader } from './contractReader';
import {
	documentIndex,
	documentMapping,
	mapDocumentTarget,
	type ContractDocument
} from '../lib/document/contract-document';
import { pointPosition } from '../lib/document/source-index';
import { unitsInRange } from '../lib/document/ranges';

/** A buyer replacement invalidates the complete template annotation footprint. */
export async function hiddenAnnotations(
	ctx: QueryCtx,
	contract: { root: Pick<Contract['root'], '_id' | 'companyId'> },
	document: ContractDocument,
	reader: Awaited<ReturnType<typeof contractReader>>
) {
	// Provenance belongs to the immutable current document. No head/ancestor reads,
	// and structural removals remain represented even when they produced no text piece.
	const buyers = new Set(
			document.pieces.flatMap((piece) =>
				piece.annotationKind === 'buyer-link' && piece.createdBy ? [piece.createdBy] : []
			)
		),
		buyerBoundaries = new Set<string>();
	const represented = new Set(
			document.pieces.flatMap((piece) => (piece.createdBy ? [piece.createdBy] : []))
		),
		removed = new Set(document.removedBlocks);
	for (const effect of document.annotationEffects ?? []) {
		buyers.add(effect.id);
		for (const key of effect.structuralBlocks)
			if (represented.has(effect.id) || (effect.removedBlocks.includes(key) && removed.has(key)))
				buyerBoundaries.add(key);
	}
	if (!buyers.size) return [] as string[];
	const pieces = new Map(document.pieces.map((piece) => [piece.sourceKey, piece])),
		index = documentIndex(document),
		hidden: string[] = [];
	const mapping = documentMapping(document);
	const deletions = document.pieces
		.filter((piece) => buyers.has(piece.createdBy ?? '') && piece.origin.start === piece.origin.end)
		.flatMap((piece) => piece.affectedRanges ?? piece.ancestors);
	const original = deletions.length ? await reader.originalIndex() : null;
	for (const item of [...(await reader.templateItems()), ...(await reader.buyerExplanations())]) {
		const targets = [
			item.trigger.target,
			...('concessions' in item
				? item.concessions.flatMap((choice) => choice.changes.map((change) => change.target))
				: [])
		];
		if (
			targets.some((target) => {
				try {
					const mapped = mapDocumentTarget(document, target, true, mapping);
					if (mapped.kind === 'boundary') return buyerBoundaries.has(mapped.afterBlockKey);
					if (original && target.kind === 'text') {
						const footprint = unitsInRange(original, target.range);
						const start = pointPosition(original, target.range.start),
							end = pointPosition(original, target.range.end);
						if (
							footprint.some((unit) =>
								deletions.some(
									(range) =>
										range.sourceKey === unit.sourceKey &&
										range.start < Math.min(unit.length, end - unit.position) &&
										range.end > Math.max(0, start - unit.position)
								)
							)
						)
							return true;
					}
					return unitsInRange(index, mapped.range).some((unit) =>
						buyers.has(pieces.get(unit.sourceKey)?.createdBy ?? '')
					);
				} catch {
					return true;
				}
			})
		)
			hidden.push(item._id);
	}
	return hidden;
}
