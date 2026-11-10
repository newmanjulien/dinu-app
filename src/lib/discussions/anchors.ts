import type { DiscussionAnchor, DiscussionPoint } from './validators';
import type { ResolvedBlock, ResolvedRun } from '../document/model';
import type { ContractItemId } from '../contract/item-identity';

export function validDiscussionAnchor(anchor: DiscussionAnchor) {
	const validPoint = (point: DiscussionPoint) =>
		point.kind === 'source'
			? Boolean(point.point.sourceKey) &&
				Number.isSafeInteger(point.point.offset) &&
				point.point.offset >= 0
			: Number.isSafeInteger(point.offset) &&
				point.offset >= 0 &&
				Number.isSafeInteger(point.origin.changeIndex) &&
				point.origin.changeIndex >= 0;
	return (
		Boolean(anchor.quote.trim()) &&
		anchor.quote.length <= 20_000 &&
		validPoint(anchor.start) &&
		validPoint(anchor.end)
	);
}
export function sameOrigin(a: ResolvedRun['generatedOrigin'], b: ResolvedRun['generatedOrigin']) {
	return Boolean(
		a &&
		b &&
		a.itemId === b.itemId &&
		a.concessionId === b.concessionId &&
		a.changeIndex === b.changeIndex
	);
}
export function runPoint(run: ResolvedRun, offset: number): DiscussionPoint | null {
	if (run.discussion?.atomic && offset !== 0 && offset !== run.text.length) return null;
	if (run.discussion)
		return {
			kind: 'replacement',
			origin: { ...run.discussion.origin, itemId: run.discussion.origin.itemId as ContractItemId },
			offset: run.discussion.offset + offset
		};
	if (run.generated === 'replacement' && run.generatedOrigin && run.generatedOffset !== undefined)
		return {
			kind: 'replacement',
			origin: { ...run.generatedOrigin, itemId: run.generatedOrigin.itemId as ContractItemId },
			offset: run.generatedOffset + offset
		};
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
	if (run.discussion) {
		if (point.kind !== 'replacement' || !sameOrigin(run.discussion.origin, point.origin))
			return null;
		const offset = point.offset - run.discussion.offset;
		if (run.discussion.atomic && offset !== 0 && offset !== run.text.length) return null;
		return offset >= 0 && offset <= run.text.length ? offset : null;
	}
	if (point.kind === 'replacement') {
		if (
			run.generated !== 'replacement' ||
			!sameOrigin(run.generatedOrigin, point.origin) ||
			run.generatedOffset === undefined
		)
			return null;
		const offset = point.offset - run.generatedOffset;
		return offset >= 0 && offset <= run.text.length ? offset : null;
	}
	if (run.generated || !run.source) return null;
	if (run.sourceKind !== 'text') {
		if (JSON.stringify(point.point) === JSON.stringify(run.source.start)) return 0;
		if (JSON.stringify(point.point) === JSON.stringify(run.source.end)) return run.text.length;
		return null;
	}
	if (point.point.sourceKey !== run.source.start.sourceKey) return null;
	const offset = point.point.offset - run.source.start.offset;
	return offset >= 0 && offset <= run.text.length ? offset : null;
}
export type PassagePart = { run: ResolvedRun; from: number; to: number; paragraph: number };
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
			if (
				run.generated === 'empty-hit-target' ||
				run.generated === 'number' ||
				run.generated === 'separator' ||
				run.revision === 'removed'
			)
				continue;
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
	let quote = '',
		last = parts[0]?.paragraph;
	for (const part of parts) {
		if (last !== part.paragraph) quote += '\n'.repeat(part.paragraph - last!);
		quote += part.run.text.slice(part.from, part.to);
		last = part.paragraph;
	}
	return !verifyQuote || quote === anchor.quote ? parts : null;
}
