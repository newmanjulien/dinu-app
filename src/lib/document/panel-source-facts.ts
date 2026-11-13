import type { ContractDocument, PieceLineage } from './contract-document';
import { complete } from './iteration';
import type { SourceBlock } from './model';
import {
	iterateSourceIndex,
	pointPosition,
	type SourceIndex,
	type SourceUnit
} from './source-index';
import type { DocumentRenderSource } from './runtime/types';

export interface PanelSourceFacts {
	readonly sourceIndex: SourceIndex;
	readonly document: ContractDocument;
	readonly baselineBlocks: readonly SourceBlock[];
	readonly baseline: SourceIndex;
	readonly originalFootprints: readonly {
		readonly unit: SourceUnit;
		readonly ranges: readonly { readonly start: number; readonly end: number }[];
	}[];
}

export function matchingPanelSourceFacts(
	facts: PanelSourceFacts | undefined,
	source: DocumentRenderSource
): facts is PanelSourceFacts {
	return Boolean(
		facts &&
		facts.sourceIndex === source.sourceIndex &&
		facts.document === source.materialized?.document &&
		facts.baselineBlocks === source.materialized?.baseline
	);
}

/** Source-only facts, in the same unit and original-range order as canonical lookup. */
export function* iteratePanelSourceFacts(
	source: DocumentRenderSource
): Generator<undefined, PanelSourceFacts | undefined> {
	const materialized = source.materialized;
	if (!materialized?.baseline.length) return;
	const baseline = yield* iterateSourceIndex(materialized.baseline);
	const pieces = new Map<string, PieceLineage>();
	for (const piece of materialized.document.pieces) {
		pieces.set(piece.sourceKey, piece); // The last piece with this key wins.
		yield undefined;
	}
	const originalFootprints: PanelSourceFacts['originalFootprints'][number][] = [];
	for (const unit of source.sourceIndex.units) {
		const ranges: { start: number; end: number }[] = [];
		for (const range of pieces.get(unit.sourceKey)?.originalRanges ?? []) {
			try {
				ranges.push({
					start: pointPosition(baseline, { sourceKey: range.sourceKey, offset: range.start }),
					end: pointPosition(baseline, { sourceKey: range.sourceKey, offset: range.end })
				});
			} catch {
				// A bad original range does not discard the other ranges in this unit.
			}
			yield undefined;
		}
		originalFootprints.push({ unit, ranges });
		yield undefined;
	}
	return {
		sourceIndex: source.sourceIndex,
		document: materialized.document,
		baselineBlocks: materialized.baseline,
		baseline,
		originalFootprints
	};
}

/** Correctness fallback for snapshots without prepared facts; shares the same source rules. */
export function buildPanelSourceFacts(source: DocumentRenderSource) {
	return complete(iteratePanelSourceFacts(source));
}
