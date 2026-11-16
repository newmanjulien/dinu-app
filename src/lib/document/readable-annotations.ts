import { pointPosition } from '$lib/document/source-index';
import type { SourceTarget } from '$lib/document/source-model';
import type { DocumentAnnotationItem } from '$lib/playbook/document-overlay';
import type { AnnotationProjectionDocument } from './runtime/types';
/** Effective readers expose summaries only where actual wording survives. */
export function readableAnnotations(
	items: readonly DocumentAnnotationItem[],
	snapshot: AnnotationProjectionDocument | null
): readonly DocumentAnnotationItem[] {
	if (!snapshot || !items.length) return [];
	const index = snapshot.source.sourceIndex;
	const intervals: { from: number; to: number }[] = [];
	const boundaries = new Set<string>();
	const generatedRanges = new Map<string, { from: number; to: number }>();
	const generatedPoints = new Set<string>();
	const identity = (target: Extract<SourceTarget, { kind: 'text' }>) =>
		JSON.stringify([
			target.range.start.sourceKey,
			target.range.start.offset,
			target.range.end.sourceKey,
			target.range.end.offset
		]);
	function add(target: SourceTarget) {
		if (target.kind === 'boundary') {
			boundaries.add(target.afterBlockKey);
			return;
		}
		intervals.push({
			from: pointPosition(index, target.range.start),
			to: pointPosition(index, target.range.end)
		});
	}
	for (const page of snapshot.pages)
		for (const { fragment } of page.placements) {
			const tokens =
				fragment.type === 'paragraph'
					? fragment.tokens
					: fragment.rows.flatMap((row) => row.flatMap((cell) => cell.tokens));
			for (const token of tokens) {
				if (
					token.lineAnchor ||
					token.revision === 'removed' ||
					token.generated === 'empty-hit-target' ||
					token.generated === 'separator' ||
					!token.value.trim()
				)
					continue;
				if (token.visualSource) {
					const target = token.visualSource;
					if (
						target.kind === 'text' &&
						pointPosition(index, target.range.start) === pointPosition(index, target.range.end)
					)
						generatedPoints.add(identity(target));
					if (target.kind === 'boundary') boundaries.add(target.afterBlockKey);
					else
						generatedRanges.set(identity(target), {
							from: pointPosition(index, target.range.start),
							to: pointPosition(index, target.range.end)
						});
				}
				if (!token.visualSource && token.source) add({ kind: 'text', range: token.source });
			}
		}
	intervals.sort((a, b) => a.from - b.from);
	const coverage: typeof intervals = [];
	for (const interval of intervals) {
		const previous = coverage.at(-1);
		if (previous && previous.to >= interval.from) previous.to = Math.max(previous.to, interval.to);
		else coverage.push({ ...interval });
	}
	const generated = [...generatedRanges.values()];
	function readable(target: SourceTarget) {
		if (target.kind === 'boundary') return boundaries.has(target.afterBlockKey);
		const from = pointPosition(index, target.range.start),
			to = pointPosition(index, target.range.end);
		if (from === to) return generatedPoints.has(identity(target));
		let low = 0,
			high = coverage.length;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (coverage[mid].to <= from) low = mid + 1;
			else high = mid;
		}
		return (
			(low < coverage.length && coverage[low].from < to) ||
			generated.some((range) => from <= range.from && to >= range.to)
		);
	}
	return items
		.map((item) => ({
			...item,
			annotations: item.annotations.filter((annotation) => readable(annotation.target))
		}))
		.filter((item) => item.annotations.length);
}
