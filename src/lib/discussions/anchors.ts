import type { DiscussionAnchor, DiscussionPoint } from './validators';
import type { ResolvedBlock, ResolvedRun } from '../document/model';

export function validDiscussionAnchor(anchor: DiscussionAnchor) {
	const validPoint = (point: DiscussionPoint) =>
		Boolean(point.point.sourceKey) &&
		Number.isSafeInteger(point.point.offset) &&
		point.point.offset >= 0;
	return (
		Boolean(anchor.quote.trim()) &&
		anchor.quote.length <= 20_000 &&
		validPoint(anchor.start) &&
		validPoint(anchor.end)
	);
}
export function runPoint(run: ResolvedRun, offset: number): DiscussionPoint | null {
	if (run.discussion?.atomic && offset !== 0 && offset !== run.text.length) return null;
	if (!run.generated && run.source) {
		const source = run.sourceOrigin ?? run.source;
		if (run.sourceKind !== 'text' && offset !== 0 && offset !== run.text.length) return null;
		return {
			kind: 'source',
			point:
				offset === run.text.length
					? source.end
					: { ...source.start, offset: source.start.offset + offset }
		};
	}
	return null;
}
export function runOffset(run: ResolvedRun, point: DiscussionPoint): number | null {
	if (run.generated || !run.source) return null;
	const source = run.sourceOrigin ?? run.source;
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
export type PassagePart = { run: ResolvedRun; from: number; to: number; paragraph: number };
export function readableDiscussionRun(run: ResolvedRun) {
	return (
		run.generated !== 'empty-hit-target' &&
		run.generated !== 'number' &&
		run.generated !== 'separator' &&
		run.revision !== 'removed'
	);
}
function passageQuote(parts: readonly PassagePart[]) {
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
		if (block.discussionRemoved) continue;
		for (const run of block.content) {
			if (!readableDiscussionRun(run)) continue;
			let from = 0;
			if (!started) {
				const offset = runOffset(run, anchor.start);
				if (offset === null || (offset === run.text.length && run.text.length > 0)) continue;
				from = offset;
				started = true;
			}
			const end = runOffset(run, anchor.end),
				to = end ?? run.text.length;
			if (to < from) return null;
			parts.push({ run, from, to, paragraph });
			if (end !== null) {
				ended = true;
				break;
			}
		}
		if (ended) break;
		paragraph++;
	}
	if (!started || !ended) return null;
	return !verifyQuote || passageQuote(parts) === anchor.quote ? parts : null;
}
