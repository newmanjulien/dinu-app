import { ContractDocumentCompositionEngine } from '../document/contract-compose';
import { documentIndex, type ContractDocument } from '../document/contract-document';
import { canonicalJson } from '../document/canonical-json';
import type { ResolvedBlock, ResolvedRun } from '../document/model';
import type { SourceIndex } from '../document/source-index';
import type { DiscussionAnchor } from './validators';
import { anchorPassage, readableDiscussionRun } from './anchors';

export type PassageInterval = { start: number; end: number };
export type DiscussionSplice = {
	beforeStart: number;
	beforeEnd: number;
	afterStart: number;
	afterEnd: number;
};
export type DiscussionMap = {
	beforeLength: number;
	afterLength: number;
	splices: DiscussionSplice[];
};
/** A gap remembers its original coordinate system. Never join historical seams. */
export type SurvivingGap = {
	start: number;
	end: number;
	currentStart: number;
	currentEnd: number;
};
type Segment = {
	start: number;
	end: number;
	origin: string;
	from: number;
	to: number;
	text: string;
	atomic: boolean;
};
export type DiscussionTape = {
	length: number;
	segments: Segment[];
	blocks: readonly ResolvedBlock[];
	positions: ReadonlyMap<ResolvedRun, PassageInterval>;
};

export function resolvedDiscussionDocument(
	document: ContractDocument,
	index: SourceIndex = documentIndex(document)
) {
	const engine = new ContractDocumentCompositionEngine(document, document.blocks, index);
	return [...engine.compose({ items: [], activeConcessions: {}, view: 'effective' })];
}

/** Same readable runs and immutable endpoints as anchorPassage. No split/run marker exists. */
export function discussionTape(document: ContractDocument): DiscussionTape {
	const index = documentIndex(document);
	const blocks = resolvedDiscussionDocument(document, index);
	const referenceDependencies = new Map(
		document.blocks.flatMap((block) =>
			block.kind === 'table'
				? []
				: block.content.flatMap((atom) => {
						if (atom.kind !== 'reference') return [];
						const { sourceKey, ...reference } = atom;
						return [
							[
								sourceKey,
								canonicalJson([
									reference,
									index.addresses.get(atom.targetItemKey)?.redirectedTo ?? atom.targetItemKey,
									atom.endTargetItemKey
										? (index.addresses.get(atom.endTargetItemKey)?.redirectedTo ??
											atom.endTargetItemKey)
										: null
								])
							] as const
						];
					})
		)
	);
	const segments: Segment[] = [],
		positions = new Map<ResolvedRun, PassageInterval>();
	let length = 0;
	function add(origin: string, from: number, to: number, text: string, atomic: boolean) {
		const start = length;
		length += to - from;
		if (length > start) segments.push({ start, end: length, origin, from, to, text, atomic });
		return { start, end: length };
	}
	for (const block of blocks) {
		if (block.kind === 'table') {
			add(`table:${block.blockKey}:${canonicalJson(block)}`, 0, 1, '', true);
			continue;
		}
		if (block.discussionRemoved) continue;
		for (const run of block.content) {
			if (!readableDiscussionRun(run)) continue;
			const source = run.sourceOrigin ?? run.source;
			// Generated numbers/separators are excluded above. Persisted effective wording
			// must have immutable provenance; silently dropping it would join two passages.
			if (!source || run.generated) {
				if (run.text.length) throw new Error('Discussion wording has no immutable source.');
				continue;
			}
			const atomic = run.sourceKind !== 'text';
			const interval = add(
				`${atomic ? 'atomic' : 'text'}:${source.start.sourceKey}${atomic ? `:${referenceDependencies.get(run.source!.start.sourceKey) ?? ''}` : ''}`,
				source.start.offset,
				atomic ? source.start.offset + 1 : source.start.offset + run.text.length,
				run.text,
				atomic
			);
			positions.set(run, interval);
		}
		// Paragraph edges have their own source-owned unit. A passage confined to
		// either neighboring paragraph does not consume this structural dependency.
		add(
			`boundary:${canonicalJson(block.boundariesAfter ?? [{ afterBlockKey: block.blockKey }])}`,
			0,
			1,
			'',
			true
		);
	}
	return { length, segments, positions, blocks };
}

export function passageInterval(
	tape: DiscussionTape,
	anchor: DiscussionAnchor
): PassageInterval | null {
	const parts = anchorPassage(tape.blocks, anchor);
	if (!parts?.length) return null;
	const first = parts[0],
		last = parts.at(-1)!;
	const start = tape.positions.get(first.run),
		end = tape.positions.get(last.run);
	if (!start || !end) return null;
	const position = (part: typeof first, interval: PassageInterval, offset: number) =>
		interval.start + (part.run.sourceKind === 'text' ? offset : offset === 0 ? 0 : 1);
	const interval = { start: position(first, start, first.from), end: position(last, end, last.to) };
	return interval.end > interval.start ? interval : null;
}

/** Compare immutable lineage and exact rendered atomic values, never search/diff quote strings. */
export function discussionTransition(before: DiscussionTape, after: DiscussionTape): DiscussionMap {
	const origins = new Map<string, Segment[]>();
	for (const segment of after.segments) {
		const rows = origins.get(segment.origin) ?? [];
		rows.push(segment);
		origins.set(segment.origin, rows);
	}
	for (const rows of origins.values()) rows.sort((a, b) => a.from - b.from);
	const anchors: { before: number; after: number; length: number }[] = [];
	for (const segment of before.segments) {
		const candidates = origins.get(segment.origin) ?? [];
		let low = 0,
			high = candidates.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (candidates[middle].to <= segment.from) low = middle + 1;
			else high = middle;
		}
		for (let i = low; i < candidates.length && candidates[i].from < segment.to; i++) {
			const target = candidates[i];
			const start = Math.max(segment.from, target.from),
				end = Math.min(segment.to, target.to);
			if (start >= end) continue;
			const left = segment.atomic
				? segment.text
				: segment.text.slice(start - segment.from, end - segment.from);
			const right = target.atomic
				? target.text
				: target.text.slice(start - target.from, end - target.from);
			if (left === right)
				anchors.push({
					before: segment.start + start - segment.from,
					after: target.start + start - target.from,
					length: end - start
				});
		}
	}
	anchors.sort((a, b) => a.before - b.before || a.after - b.after);
	const splices: DiscussionSplice[] = [];
	let old = 0,
		next = 0;
	for (const anchor of [...anchors, { before: before.length, after: after.length, length: 0 }]) {
		if (anchor.before < old || anchor.after < next)
			throw new Error('Discussion lineage is not monotone.');
		if (anchor.before > old || anchor.after > next)
			splices.push({
				beforeStart: old,
				beforeEnd: anchor.before,
				afterStart: next,
				afterEnd: anchor.after
			});
		old = anchor.before + anchor.length;
		next = anchor.after + anchor.length;
	}
	return { beforeLength: before.length, afterLength: after.length, splices };
}

/** Insertions use right affinity at a passage start and left affinity at its end. */
export function mapPassage(interval: PassageInterval, map: DiscussionMap): PassageInterval | null {
	let displacement = 0;
	for (const splice of map.splices) {
		if (splice.beforeStart >= interval.end) break;
		if (splice.beforeEnd > interval.start && splice.beforeStart < interval.end) return null;
		if (
			splice.beforeStart === splice.beforeEnd &&
			splice.beforeStart > interval.start &&
			splice.beforeStart < interval.end
		)
			return null;
		if (splice.beforeEnd <= interval.start) displacement = splice.afterEnd - splice.beforeEnd;
	}
	return { start: interval.start + displacement, end: interval.end + displacement };
}

export function* unchangedGaps(map: DiscussionMap): Generator<SurvivingGap> {
	let before = 0,
		after = 0;
	for (const splice of map.splices) {
		if (splice.beforeStart > before)
			yield {
				start: before,
				end: splice.beforeStart,
				currentStart: after,
				currentEnd: splice.afterStart
			};
		before = splice.beforeEnd;
		after = splice.afterEnd;
	}
	if (map.beforeLength > before)
		yield {
			start: before,
			end: map.beforeLength,
			currentStart: after,
			currentEnd: map.afterLength
		};
}

/** Streaming composition retains each seam even if an inverse later restores identical text. */
export function* survivingGaps(
	length: number,
	maps: readonly DiscussionMap[]
): Generator<SurvivingGap> {
	function* advance(gap: SurvivingGap, index: number): Generator<SurvivingGap> {
		if (index === maps.length) {
			yield gap;
			return;
		}
		for (const next of unchangedGaps(maps[index])) {
			const start = Math.max(gap.currentStart, next.start),
				end = Math.min(gap.currentEnd, next.end);
			if (start >= end) continue;
			yield* advance(
				{
					start: gap.start + start - gap.currentStart,
					end: gap.start + end - gap.currentStart,
					currentStart: next.currentStart + start - next.start,
					currentEnd: next.currentStart + end - next.start
				},
				index + 1
			);
		}
	}
	yield* advance({ start: 0, end: length, currentStart: 0, currentEnd: length }, 0);
}
