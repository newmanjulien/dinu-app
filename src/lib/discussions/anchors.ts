import type { Id } from '../../convex/_generated/dataModel';
import type { DiscussionAnchor, DiscussionFootprint, DiscussionPoint } from './validators';
import type { ResolvedBlock, ResolvedRun } from '../document/model';
import { pointPosition } from '../document/source-index';
import type { GeneratedBlockAnchor } from '../document/structural-changes';
import type { ValidationSourceFacts } from '../document/validation-source';
import type { ConcessionSelection } from '../playbook/model';
import {
	activeConcessionChanges,
	collectOverlayImpact,
	type OverlayImpactItem,
	type SplitBreak
} from '../playbook/overlay-impact';

export type { GeneratedBlockAnchor };

export function validDiscussionAnchor(anchor: DiscussionAnchor) {
	const validPoint = (point: DiscussionPoint) =>
		point.kind === 'source'
			? Boolean(point.point.sourceKey) &&
				Number.isSafeInteger(point.point.offset) &&
				point.point.offset >= 0
			: Boolean(point.itemId) &&
				Boolean(point.concessionId) &&
				Number.isSafeInteger(point.changeIndex) &&
				point.changeIndex >= 0 &&
				Number.isSafeInteger(point.offset) &&
				point.offset >= 0;
	return (
		Boolean(anchor.quote.trim()) &&
		anchor.quote.length <= 20_000 &&
		validPoint(anchor.start) &&
		validPoint(anchor.end)
	);
}

export function runPoint(run: ResolvedRun, offset: number): DiscussionPoint | null {
	if (run.discussion) {
		if (run.discussion.atomic && offset !== 0 && offset !== run.text.length) return null;
		return {
			kind: 'concession',
			itemId: run.discussion.origin.itemId as Id<'playbookItems'>,
			concessionId: run.discussion.origin.concessionId,
			changeIndex: run.discussion.origin.changeIndex,
			offset: run.discussion.atomic
				? run.discussion.offset + (offset === 0 ? 0 : 1)
				: run.discussion.offset + offset
		};
	}
	if (!run.generated && run.source) {
		if (run.sourceKind !== 'text' && offset !== 0 && offset !== run.text.length) return null;
		return {
			kind: 'source',
			point:
				offset === run.text.length
					? run.source.end
					: { ...run.source.start, offset: run.source.start.offset + offset }
		};
	}
	return null;
}

export function runOffset(run: ResolvedRun, point: DiscussionPoint): number | null {
	if (point.kind === 'concession') {
		if (!run.discussion) return null;
		const { origin, offset: base, atomic } = run.discussion;
		if (
			origin.itemId !== point.itemId ||
			origin.concessionId !== point.concessionId ||
			origin.changeIndex !== point.changeIndex
		)
			return null;
		if (atomic) {
			if (point.offset === base) return 0;
			if (point.offset === base + 1) return run.text.length;
			return null;
		}
		const relative = point.offset - base;
		return relative >= 0 && relative <= run.text.length ? relative : null;
	}
	if (run.discussion || run.generated || !run.source) return null;
	const source = run.source;
	if (run.sourceKind !== 'text') {
		if (
			point.point.sourceKey === source.start.sourceKey &&
			point.point.offset === source.start.offset
		)
			return 0;
		if (point.point.sourceKey === source.end.sourceKey && point.point.offset === source.end.offset)
			return run.text.length;
		return null;
	}
	if (point.point.sourceKey !== source.start.sourceKey) return null;
	const offset = point.point.offset - source.start.offset;
	return offset >= 0 && offset <= run.text.length ? offset : null;
}

export type PassagePart = {
	run: ResolvedRun;
	from: number;
	to: number;
	paragraph: number;
	blockKey: string;
};

export function readableDiscussionRun(run: ResolvedRun) {
	return (
		run.generated !== 'empty-hit-target' &&
		run.generated !== 'number' &&
		run.generated !== 'separator' &&
		run.revision !== 'removed'
	);
}

export function passageQuote(parts: readonly PassagePart[]) {
	let quote = '',
		last = parts[0]?.paragraph;
	for (const part of parts) {
		if (last !== part.paragraph) quote += '\n'.repeat(part.paragraph - last!);
		quote += part.run.text.slice(part.from, part.to);
		last = part.paragraph;
	}
	return quote;
}

/** Resolve immutable coordinates, never search for a matching quote elsewhere. */
export function anchorPassage(
	blocks: readonly ResolvedBlock[],
	anchor: DiscussionAnchor,
	verifyQuote = true
): PassagePart[] | null {
	const parts: PassagePart[] = [];
	let started = false,
		ended = false,
		paragraph = 0;
	for (const block of blocks) {
		if (block.kind !== 'paragraph') {
			if (started && !ended) return null;
			continue;
		}
		let hasReadable = false;
		for (const run of block.content) {
			if (!readableDiscussionRun(run) || !run.text.length) continue;
			hasReadable = true;
			let from = 0;
			if (!started) {
				const offset = runOffset(run, anchor.start);
				if (offset === null || offset === run.text.length) continue;
				from = offset;
				started = true;
			}
			const end = runOffset(run, anchor.end),
				to = end ?? run.text.length;
			if (to < from) return null;
			parts.push({
				run,
				from,
				to,
				paragraph,
				blockKey: block.blockKey
			});
			if (end !== null) {
				ended = true;
				break;
			}
		}
		if (ended) break;
		if (hasReadable) paragraph++;
	}
	if (!started || !ended) return null;
	return !verifyQuote || passageQuote(parts) === anchor.quote ? parts : null;
}

function partBlockOrdinal(
	index: ValidationSourceFacts,
	part: PassagePart,
	generatedAnchors?: ReadonlyMap<string, GeneratedBlockAnchor>
): number | undefined {
	const generated = generatedAnchors?.get(part.blockKey);
	if (generated) {
		const ordinal = index.blockOrdinals.get(generated.afterBlockKey);
		if (ordinal === undefined) return undefined;
		return ordinal * 3 + (generated.kind === 'split' ? 1 : 2);
	}
	const direct = index.blockOrdinals.get(part.blockKey);
	return direct !== undefined ? direct * 3 : undefined;
}

/** Structural footprint recorded when a comment is created for strict concession invalidation. */
export function extractFootprint(
	index: ValidationSourceFacts,
	parts: readonly PassagePart[],
	generatedAnchors?: ReadonlyMap<string, GeneratedBlockAnchor>
): DiscussionFootprint {
	let templateStart: number | undefined;
	let templateEnd: number | undefined;
	let blockSpanStart: number | undefined;
	let blockSpanEnd: number | undefined;
	const blockKeys: string[] = [];
	const seenBlocks = new Set<string>();
	const concessionMap = new Map<string, { itemId: Id<'playbookItems'>; concessionId: string }>();
	const recordTemplateSpan = (fromPos: number, toPos: number) => {
		templateStart = templateStart === undefined ? fromPos : Math.min(templateStart, fromPos);
		templateEnd = templateEnd === undefined ? toPos : Math.max(templateEnd, toPos);
	};
	for (const part of parts) {
		if (!seenBlocks.has(part.blockKey)) {
			seenBlocks.add(part.blockKey);
			blockKeys.push(part.blockKey);
		}
		const blockCoord = partBlockOrdinal(index, part, generatedAnchors);
		if (blockCoord !== undefined) {
			blockSpanStart =
				blockSpanStart === undefined ? blockCoord : Math.min(blockSpanStart, blockCoord);
			blockSpanEnd = blockSpanEnd === undefined ? blockCoord : Math.max(blockSpanEnd, blockCoord);
		}
		if (part.run.discussion) {
			const { itemId, concessionId } = part.run.discussion.origin;
			const key = `${itemId}:${concessionId}`;
			if (!concessionMap.has(key)) {
				concessionMap.set(key, {
					itemId: itemId as Id<'playbookItems'>,
					concessionId
				});
			}
			if (part.run.visualSource?.kind === 'text') {
				recordTemplateSpan(
					pointPosition(index, part.run.visualSource.range.start),
					pointPosition(index, part.run.visualSource.range.end)
				);
			}
			continue;
		}
		if (part.run.source) {
			let fromPos: number;
			let toPos: number;
			if (part.run.sourceKind === 'text') {
				const unit = index.byKey.get(part.run.source.start.sourceKey);
				if (!unit) continue;
				fromPos = unit.position + part.run.source.start.offset + part.from;
				toPos = unit.position + part.run.source.start.offset + part.to;
			} else {
				fromPos = pointPosition(index, part.run.source.start);
				toPos = pointPosition(index, part.run.source.end);
			}
			recordTemplateSpan(fromPos, toPos);
		}
	}
	return {
		...(templateStart !== undefined ? { templateStart } : {}),
		...(templateEnd !== undefined ? { templateEnd } : {}),
		...(blockSpanStart !== undefined && blockSpanEnd !== undefined
			? { blockSpan: { start: blockSpanStart, end: blockSpanEnd } }
			: {}),
		blockKeys,
		concessions: [...concessionMap.values()]
	};
}

export interface ConcessionChangeSet {
	removedConcessions: ReadonlySet<string>;
	textRanges: readonly { start: number; end: number }[];
	insertedAfterBlocks: ReadonlySet<string>;
	insertedBoundaryOrdinals: readonly number[];
	splitBreaks: readonly SplitBreak[];
	removedBlocks: ReadonlySet<string>;
	toggledRemovedOrdinals: readonly number[];
}

/** Compute the structural regions touched when approved concessions transition from prev to next. */
export function buildConcessionChangeSet(
	index: ValidationSourceFacts,
	prevConcessions: ConcessionSelection,
	nextConcessions: ConcessionSelection,
	overlays: readonly OverlayImpactItem[]
): ConcessionChangeSet {
	const changedItems = new Set<string>();
	const removedConcessions = new Set<string>();
	for (const itemId of new Set([
		...Object.keys(prevConcessions),
		...Object.keys(nextConcessions)
	])) {
		const prev = prevConcessions[itemId];
		const next = nextConcessions[itemId];
		if (prev !== next) {
			changedItems.add(itemId);
			if (prev) removedConcessions.add(`${itemId}:${prev}`);
		}
	}
	const changedConcessionChanges = [];
	for (const item of overlays) {
		if (!changedItems.has(item.itemId)) continue;
		for (const concessionId of [prevConcessions[item.itemId], nextConcessions[item.itemId]]) {
			if (!concessionId) continue;
			const concession = item.concessions.find((c) => c.id === concessionId);
			if (!concession) continue;
			for (const change of concession.changes) changedConcessionChanges.push(change);
		}
	}
	const changedImpact = collectOverlayImpact(index, changedConcessionChanges);
	const prevImpact = collectOverlayImpact(
		index,
		activeConcessionChanges(overlays, prevConcessions)
	);
	const nextImpact = collectOverlayImpact(
		index,
		activeConcessionChanges(overlays, nextConcessions)
	);

	const removedBlocks = new Set<string>();
	for (const key of prevImpact.removedBlocks)
		if (!nextImpact.removedBlocks.has(key)) removedBlocks.add(key);
	for (const key of nextImpact.removedBlocks)
		if (!prevImpact.removedBlocks.has(key)) removedBlocks.add(key);

	const toggledRemovedOrdinals: number[] = [];
	for (const key of removedBlocks) {
		const ordinal = index.blockOrdinals.get(key);
		if (ordinal !== undefined) toggledRemovedOrdinals.push(ordinal * 3);
	}

	return {
		removedConcessions,
		textRanges: changedImpact.textRanges,
		insertedAfterBlocks: changedImpact.insertedAfterBlocks,
		insertedBoundaryOrdinals: changedImpact.insertedBoundaryOrdinals,
		splitBreaks: changedImpact.splitBreaks,
		removedBlocks,
		toggledRemovedOrdinals
	};
}

/** Strict invalidation check: returns true if the concession transition touches or splits the comment. */
export function footprintAffectedByChanges(
	footprint: DiscussionFootprint,
	changes: ConcessionChangeSet
): boolean {
	for (const c of footprint.concessions) {
		if (changes.removedConcessions.has(`${c.itemId}:${c.concessionId}`)) return true;
	}
	for (const blockKey of footprint.blockKeys) {
		if (changes.removedBlocks.has(blockKey)) return true;
	}
	if (footprint.blockSpan) {
		const { start, end } = footprint.blockSpan;
		for (const coord of changes.insertedBoundaryOrdinals) {
			if (start < coord && coord < end) return true;
		}
		for (const coord of changes.toggledRemovedOrdinals) {
			if (start < coord && coord < end) return true;
		}
		for (const split of changes.splitBreaks) {
			if (
				start < split.ordinal &&
				split.ordinal < end &&
				(footprint.templateStart === undefined || split.position > footprint.templateStart)
			)
				return true;
		}
	} else if (footprint.blockKeys.length > 1) {
		for (let i = 0; i < footprint.blockKeys.length - 1; i++) {
			if (changes.insertedAfterBlocks.has(footprint.blockKeys[i])) return true;
		}
	}
	if (footprint.templateStart !== undefined && footprint.templateEnd !== undefined) {
		const fStart = footprint.templateStart;
		const fEnd = footprint.templateEnd;
		for (const { start, end } of changes.textRanges) {
			if (start === end ? fStart < start && start < fEnd : start < fEnd && end > fStart)
				return true;
		}
	}
	return false;
}
