import { unitsInRange } from '$lib/document/ranges';
import {
	pointPosition,
	resolvePoint,
	type SourceIndex,
	type SourceUnit
} from '$lib/document/source-index';
import type { SourcePoint, SourceRange } from '$lib/document/source-model';

type SourceTextToken = {
	text: Text;
	unit: SourceUnit;
	from: number;
	to: number;
};

function sourceBlockSelector(
	index: SourceIndex,
	range: SourceRange,
	descendants: readonly string[]
) {
	const blockKeys = new Set(unitsInRange(index, range).map((unit) => unit.blockKey));
	return [...blockKeys]
		.flatMap((key) =>
			descendants.map((descendant) => `[data-block-key="${CSS.escape(key)}"] ${descendant}`)
		)
		.join(',');
}

/** Read the source identity carried by one visible text token. */
export function sourceTextToken(
	root: HTMLElement,
	text: Text,
	index: SourceIndex
): SourceTextToken | null {
	const parent = text.parentElement;
	const document = parent?.closest<HTMLElement>('.document-content');
	if (
		!parent ||
		!root.contains(parent) ||
		!document ||
		!root.contains(document) ||
		parent.closest(
			'[aria-hidden="true"], [data-document-control], [data-revision], del, ins, table'
		)
	)
		return null;
	const span = parent.closest<HTMLElement>('[data-source-start-key]');
	if (!span || !root.contains(span) || span.textContent !== text.data) return null;
	const key = span.dataset.sourceStartKey;
	const from = Number(span.dataset.sourceStartOffset),
		to = Number(span.dataset.sourceEndOffset);
	if (
		!key ||
		key !== span.dataset.sourceEndKey ||
		!Number.isSafeInteger(from) ||
		!Number.isSafeInteger(to)
	)
		return null;
	try {
		const unit = resolvePoint(index, { sourceKey: key, offset: from });
		resolvePoint(index, { sourceKey: key, offset: to });
		if (unit.kind !== span.dataset.sourceKind) return null;
		if (
			unit.kind === 'text' &&
			(to - from !== text.length || unit.displayText.slice(from, to) !== text.data)
		)
			return null;
		if (unit.kind !== 'text' && (from !== 0 || to !== 1)) return null;
		return { text, unit, from, to };
	} catch {
		return null;
	}
}

/** Resolve source coordinates into visible text ranges, including fragments split across pages. */
export function sourceRangeToDomRanges(
	root: HTMLElement,
	range: SourceRange,
	index: SourceIndex
): Range[] {
	let start: number, end: number;
	try {
		start = pointPosition(index, range.start);
		end = pointPosition(index, range.end);
	} catch {
		return [];
	}
	if (start >= end) return [];
	const ranges: Range[] = [];
	let current: Range | undefined;
	let block: Element | null = null;
	const selector = sourceBlockSelector(index, range, [
		'[data-source-start-key]',
		'[data-generated]'
	]);
	if (!selector) return [];
	for (const span of root.querySelectorAll<HTMLElement>(selector)) {
		const nextBlock = span.closest('.document-block');
		if (nextBlock !== block) current = undefined;
		block = nextBlock;
		if (span.closest('[data-revision], del, ins, [aria-hidden="true"]')) {
			current = undefined;
			continue;
		}
		// Bridge separators only when selected source text follows in the same block.
		if (span.dataset.generated === 'separator') continue;
		if (span.dataset.generated) {
			current = undefined;
			continue;
		}
		const unit = index.byKey.get(span.dataset.sourceStartKey!);
		const text = span.firstChild;
		const from = Number(span.dataset.sourceStartOffset),
			to = Number(span.dataset.sourceEndOffset);
		if (
			!unit ||
			span.dataset.sourceEndKey !== unit.sourceKey ||
			!text ||
			text.nodeType !== Node.TEXT_NODE ||
			!Number.isSafeInteger(from) ||
			!Number.isSafeInteger(to) ||
			from < 0 ||
			to > unit.length ||
			from >= to
		) {
			current = undefined;
			continue;
		}
		const overlapStart = Math.max(start, unit.position + from),
			overlapEnd = Math.min(end, unit.position + to);
		if (overlapStart >= overlapEnd) {
			current = undefined;
			continue;
		}
		const length = text.textContent?.length ?? 0;
		if (unit.kind === 'text' && length !== to - from) {
			current = undefined;
			continue;
		}
		if (!current) {
			current = root.ownerDocument.createRange();
			current.setStart(text, unit.kind === 'text' ? overlapStart - unit.position - from : 0);
			ranges.push(current);
		}
		current.setEnd(text, unit.kind === 'text' ? overlapEnd - unit.position - from : length);
	}
	return ranges;
}

/** A captured envelope is imported only through its current production surface. */
export function importDomSelection(
	captured: import('./selection-gesture').CapturedNativeSelection,
	context: import('./selection-surface').SelectionSurface
) {
	return context.importNative(captured);
}

/** All selected text, including unowned leading/trailing whitespace, is evidence. */
export function readSelectedDomEnvelope(
	root: HTMLElement,
	range: Range,
	classify: (text: Text, from: number, to: number) => boolean
): boolean {
	if (
		!root.isConnected ||
		!root.contains(range.startContainer) ||
		!root.contains(range.endContainer)
	)
		return false;
	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	try {
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const text = node as Text;
			const from =
				range.startContainer === text
					? range.startOffset
					: range.comparePoint(text, 0) >= 0
						? 0
						: text.length;
			const to =
				range.endContainer === text
					? range.endOffset
					: range.comparePoint(text, text.length) <= 0
						? text.length
						: 0;
			if (from >= to) continue;
			if (text.parentElement?.closest('[data-document-chrome], [data-document-control]')) continue;
			if (!classify(text, from, to)) return false;
		}
		return true;
	} catch {
		return false;
	}
}

export interface SourceOccurrencePreference {
	pageNumber: number;
	fragmentIdentity: string;
}

export function sourceOccurrence(span: HTMLElement): SourceOccurrencePreference {
	const block = span.closest<HTMLElement>('[data-source-fragment-key]');
	return {
		pageNumber: Number(span.closest<HTMLElement>('.document-page')?.dataset.pageNumber),
		fragmentIdentity: block?.dataset.sourceFragmentKey ?? ''
	};
}

/** Locate a source point again after panel layout or pagination changes. */
export function sourcePointBounds(
	root: HTMLElement,
	point: SourcePoint,
	includeRemoved = false,
	preference?: SourceOccurrencePreference
): DOMRect | null {
	const spans = Array.from(
		root.querySelectorAll<HTMLElement>(`[data-source-start-key="${CSS.escape(point.sourceKey)}"]`)
	);
	if (preference)
		spans.sort((a, b) => {
			const rank = (span: HTMLElement) => {
				const occurrence = sourceOccurrence(span);
				const distance = Math.abs(occurrence.pageNumber - preference.pageNumber);
				return distance === 0 && occurrence.fragmentIdentity === preference.fragmentIdentity
					? -1
					: distance;
			};
			return rank(a) - rank(b);
		});
	for (const span of spans) {
		const from = Number(span.dataset.sourceStartOffset),
			to = Number(span.dataset.sourceEndOffset);
		if (
			span.dataset.sourceStartKey !== point.sourceKey ||
			(span.dataset.revision && !(includeRemoved && span.dataset.revision === 'removed')) ||
			point.offset < from ||
			point.offset > to
		)
			continue;
		const text = span.firstChild;
		if (span.dataset.sourceKind === 'text' && text?.nodeType === Node.TEXT_NODE) {
			const caret = root.ownerDocument.createRange();
			caret.setStart(text, Math.min(point.offset - from, text.textContent?.length ?? 0));
			caret.collapse(true);
			const bounds = caret.getClientRects()[0];
			if (bounds?.height) return bounds;
		}
		const bounds = span.getBoundingClientRect();
		if (bounds.height) return bounds;
	}
	return null;
}
