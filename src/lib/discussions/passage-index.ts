import { strFromU8, strToU8, zlibSync, unzlibSync } from 'fflate';
import type { DiscussionAnchor, DiscussionPoint } from './validators';
import { readableDiscussionRun } from './anchors';
import type { DiscussionTape, PassageInterval } from './tape';

export const MAX_PASSAGE_INDEX_BYTES = 512 * 1024;

type IndexedRun = {
	text: string;
	paragraph: number;
	tableGroup: number;
	textSource: boolean;
	startKey: string | null;
	startOffset: number;
	endKey: string | null;
	endOffset: number;
	tapeStart: number | null;
	tapeEnd: number | null;
};
type PassageIndex = {
	format: 1;
	length: number;
	runs: IndexedRun[];
	bySource: Record<string, number[]>;
};

/** The same readable run order, paragraph gaps and table stops as anchorPassage. */
export function buildPassageIndex(tape: DiscussionTape): ArrayBuffer {
	const runs: IndexedRun[] = [];
	const bySource: Record<string, number[]> = Object.create(null);
	let paragraph = 0;
	let tableGroup = 0;
	for (const block of tape.blocks) {
		if (block.kind !== 'paragraph') {
			tableGroup++;
			continue;
		}
		if (block.discussionRemoved) continue;
		for (const run of block.content) {
			if (!readableDiscussionRun(run)) continue;
			const source = !run.generated && run.source ? (run.sourceOrigin ?? run.source) : null;
			const position = tape.positions.get(run);
			const entry: IndexedRun = {
				text: run.text,
				paragraph,
				tableGroup,
				textSource: run.sourceKind === 'text',
				startKey: source?.start.sourceKey ?? null,
				startOffset: source?.start.offset ?? 0,
				endKey: source?.end.sourceKey ?? null,
				endOffset: source?.end.offset ?? 0,
				tapeStart: position?.start ?? null,
				tapeEnd: position?.end ?? null
			};
			const ordinal = runs.push(entry) - 1;
			if (entry.startKey !== null) (bySource[entry.startKey] ??= []).push(ordinal);
			if (entry.endKey !== null && entry.endKey !== entry.startKey)
				(bySource[entry.endKey] ??= []).push(ordinal);
		}
		paragraph++;
	}
	const data: PassageIndex = { format: 1, length: tape.length, runs, bySource };
	return zlibSync(strToU8(JSON.stringify(data))).slice().buffer as ArrayBuffer;
}

function runOffset(run: IndexedRun, point: DiscussionPoint): number | null {
	if (run.startKey === null) return null;
	if (!run.textSource) {
		if (point.point.sourceKey === run.startKey && point.point.offset === run.startOffset) return 0;
		if (point.point.sourceKey === run.endKey && point.point.offset === run.endOffset)
			return run.text.length;
		return null;
	}
	if (point.point.sourceKey !== run.startKey) return null;
	const offset = point.point.offset - run.startOffset;
	return offset >= 0 && offset <= run.text.length ? offset : null;
}

/** Resolve immutable coordinates through the cached run order; never search quote text. */
export function indexedPassage(
	data: ArrayBuffer,
	anchor: DiscussionAnchor
): { interval: PassageInterval | null; tapeLength: number } {
	const index = JSON.parse(strFromU8(unzlibSync(new Uint8Array(data)))) as PassageIndex;
	if (index.format !== 1) throw new Error('Unsupported discussion passage index.');
	const candidates = Object.hasOwn(index.bySource, anchor.start.point.sourceKey)
		? index.bySource[anchor.start.point.sourceKey]
		: [];
	let first = -1;
	let from = 0;
	for (const ordinal of candidates) {
		const run = index.runs[ordinal];
		const offset = runOffset(run, anchor.start);
		if (offset === null || (offset === run.text.length && run.text.length > 0)) continue;
		first = ordinal;
		from = offset;
		break;
	}
	if (first < 0) return { interval: null, tapeLength: index.length };
	let quote = '';
	const start = index.runs[first];
	let previousParagraph = start.paragraph;
	for (let ordinal = first; ordinal < index.runs.length; ordinal++) {
		const run = index.runs[ordinal];
		if (run.tableGroup !== start.tableGroup) break;
		if (run.paragraph !== previousParagraph)
			quote += '\n'.repeat(run.paragraph - previousParagraph);
		const offset = ordinal === first ? from : 0;
		const end = runOffset(run, anchor.end);
		const to = end ?? run.text.length;
		if (to < offset) break;
		quote += run.text.slice(offset, to);
		if (!anchor.quote.startsWith(quote)) break;
		if (end !== null) {
			if (quote !== anchor.quote || start.tapeStart === null || run.tapeStart === null) break;
			const interval = {
				start: start.tapeStart + (start.textSource ? from : from === 0 ? 0 : 1),
				end: run.tapeStart + (run.textSource ? to : to === 0 ? 0 : 1)
			};
			return {
				interval: interval.end > interval.start ? interval : null,
				tapeLength: index.length
			};
		}
		previousParagraph = run.paragraph;
	}
	return { interval: null, tapeLength: index.length };
}
