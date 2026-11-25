import type { DeepReadonly } from '../immutable';
import { crossesBoundary, targetContainers, targetPosition } from '../document/ranges';
import { hasMeaningfulReplacement } from '../document/replacement-content';
import { pointPosition } from '../document/source-index';
import type { SourceTarget } from '../document/source-model';
import { replacementParagraphs } from '../document/structural-changes';
import type { ValidationSourceFacts } from '../document/validation-source';
import type { ConcessionSelection, ContractChange } from './model';

export interface OverlayImpactItem {
	readonly itemId: string;
	readonly concessions: DeepReadonly<readonly { id: string; changes: readonly ContractChange[] }[]>;
}

export interface SplitBreak {
	/** Source position of the split range end (where trailing text transfers into the split paragraph). */
	readonly position: number;
	/** 3-slot block ordinal (`3 * k + 1`) of the split paragraphs emitted after source block `k`. */
	readonly ordinal: number;
}

export interface OverlayImpact {
	/** Source-offset intervals for active text changes. */
	readonly textRanges: readonly { start: number; end: number }[];
	/** Source block keys structurally removed by multi-paragraph text collapses. */
	readonly removedBlocks: ReadonlySet<string>;
	/** Boundary targetPosition values for `crossesBoundary` range checks (real boundary insertions only). */
	readonly boundaryPositions: readonly number[];
	/** Source block keys after which a real boundary change inserts paragraphs. */
	readonly insertedAfterBlocks: ReadonlySet<string>;
	/** 3-slot block ordinals (`3 * k + 2`) where real boundary changes insert paragraphs after block `k`. */
	readonly insertedBoundaryOrdinals: readonly number[];
	/** Paragraph splits produced by text changes expanding beyond their target containers. */
	readonly splitBreaks: readonly SplitBreak[];
}

export function activeConcessionChanges(
	overlays: readonly OverlayImpactItem[],
	selection: ConcessionSelection
): DeepReadonly<ContractChange>[] {
	const changes: DeepReadonly<ContractChange>[] = [];
	for (const item of overlays) {
		const active = item.concessions.find((c) => c.id === selection[item.itemId]);
		if (!active) continue;
		for (const change of active.changes) changes.push(change);
	}
	return changes;
}

/** Collect structural and text impacts of concession changes using only compact ValidationSourceFacts. */
export function collectOverlayImpact(
	index: ValidationSourceFacts,
	changes: readonly DeepReadonly<ContractChange>[]
): OverlayImpact {
	const textRanges: { start: number; end: number }[] = [];
	const removedBlocks = new Set<string>();
	const boundaryPositions = new Set<number>();
	const insertedAfterBlocks = new Set<string>();
	const insertedBoundaryOrdinals = new Set<number>();
	const splitBreaks: SplitBreak[] = [];

	for (const change of changes) {
		const containers = targetContainers(index, change.target);
		const paragraphs = replacementParagraphs(change.replacement);
		if (change.target.kind === 'text') {
			const start = pointPosition(index, change.target.range.start);
			const end = pointPosition(index, change.target.range.end);
			textRanges.push({ start, end });
			const used = Math.min(containers.length, paragraphs.length);
			for (let i = used; i < containers.length; i++) {
				removedBlocks.add(containers[i].blockKey);
			}
			if (paragraphs.length > containers.length) {
				const lastBlockKey = containers.at(-1)!.blockKey;
				const ordinal = index.blockOrdinals.get(lastBlockKey);
				if (ordinal !== undefined) splitBreaks.push({ position: end, ordinal: ordinal * 3 + 1 });
			}
		} else {
			if (!hasMeaningfulReplacement(change.replacement)) continue;
			const afterBlockKey = change.target.afterBlockKey;
			insertedAfterBlocks.add(afterBlockKey);
			boundaryPositions.add(targetPosition(index, change.target));
			const ordinal = index.blockOrdinals.get(afterBlockKey);
			if (ordinal !== undefined) insertedBoundaryOrdinals.add(ordinal * 3 + 2);
		}
	}

	return {
		textRanges,
		removedBlocks,
		boundaryPositions: [...boundaryPositions],
		insertedAfterBlocks,
		insertedBoundaryOrdinals: [...insertedBoundaryOrdinals],
		splitBreaks
	};
}

/** Strict overlap test for a source text target against removed blocks, text edits, and crossed boundaries. */
export function textRangeOverlapsImpact(
	index: ValidationSourceFacts,
	target: Extract<SourceTarget, { kind: 'text' }>,
	impact: OverlayImpact
): boolean {
	for (const container of targetContainers(index, target)) {
		if (impact.removedBlocks.has(container.blockKey)) return true;
	}
	const start = pointPosition(index, target.range.start);
	const end = pointPosition(index, target.range.end);
	for (const range of impact.textRanges) {
		if (
			range.start === range.end
				? start < range.start && range.start < end
				: range.start < end && range.end > start
		)
			return true;
	}
	if (impact.boundaryPositions.length) {
		const doubledStart = start * 2;
		const doubledEnd = end * 2;
		for (const boundary of impact.boundaryPositions) {
			if (crossesBoundary(doubledStart, doubledEnd, boundary)) return true;
		}
	}
	return false;
}
