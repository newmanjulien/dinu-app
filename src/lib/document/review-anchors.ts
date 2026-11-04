import { pointPosition, type SourceIndex } from '$lib/contract/source-index';
import type { ReviewTag } from '$lib/contract/approval';
import { isTextTarget, type SourceRange, type SourceTarget } from '$lib/contract/source-model';
import { targetPosition } from '$lib/contract/ranges';
import type { PaginatedPage } from './pagination/types';
import { sourcePointBounds } from './selection/dom-selection';

export type ReviewAnchor = {
	key: string;
	itemId: string;
	order: number;
	page: number;
	target: number;
	top: number;
};
type TextLocation = {
	kind: 'text';
	key: string;
	itemId: string;
	range: SourceRange;
	start: number;
	end: number;
};
type BoundaryLocation = {
	kind: 'boundary';
	key: string;
	itemId: string;
	afterBlockKey: string;
	start: number;
	end: number;
};
type Location = TextLocation | BoundaryLocation;
type Token = {
	span: HTMLElement;
	start: number;
	end: number;
	containerKey: string;
	generated: boolean;
	top?: number | null;
};
type Projection = { generated: boolean; target?: number; insertedTarget?: number };
type Fallback = { target: number; distance: number };
type CachedPage = {
	page: PaginatedPage;
	element: HTMLElement;
	tokens: Token[];
	maxEnds: number[];
	containers: Map<string, Token[]>;
	boundaries: Map<string, HTMLElement>;
	geometryKey?: string;
	projections: Projection[];
	fallbacks: Map<string, Fallback | null>;
};

/** Token order can differ from source order (tables, revisions, repeated headers).
 * Prefix maxima also handle overlapping generated ranges without a document-wide scan. */
function firstCandidate(page: CachedPage, start: number) {
	let low = 0,
		high = page.maxEnds.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (page.maxEnds[mid] < start) low = mid + 1;
		else high = mid;
	}
	return low;
}

/** Cache source parsing and location projection by immutable page content. Coordinates
 * stay relative to the page, so appended pages and viewport scaling reuse earlier work. */
export class ReviewAnchorProjector {
	private index?: SourceIndex;
	private geometryKey?: string;
	private locations: Location[] = [];
	private cache = new Map<number, CachedPage>();

	project(
		host: HTMLElement,
		tags: readonly Pick<ReviewTag, 'itemId' | 'lifecycle' | 'range'>[],
		index: SourceIndex,
		pages: readonly PaginatedPage[],
		scale: number,
		geometryKey: string
	): ReviewAnchor[] {
		if (this.index !== index) {
			this.cache.clear();
			this.geometryKey = undefined;
			this.index = index;
		}
		if (this.geometryKey !== geometryKey) {
			this.geometryKey = geometryKey;
			this.locations = tags.flatMap<Location>((tag): Location[] => {
				try {
					const key = JSON.stringify([tag.itemId, tag.lifecycle]);
					if (!isTextTarget(tag.range)) {
						const position = targetPosition(index, tag.range);
						return [
							{
								kind: 'boundary' as const,
								key,
								itemId: tag.itemId,
								afterBlockKey: tag.range.afterBlockKey,
								start: position,
								end: position
							}
						];
					}
					return [
						{
							kind: 'text' as const,
							key,
							itemId: tag.itemId,
							range: tag.range.range,
							start: pointPosition(index, tag.range.range.start),
							end: pointPosition(index, tag.range.range.end)
						}
					];
				} catch {
					// Invalid source is handled by the document's existing failure state.
					return [];
				}
			});
		}
		if (!this.locations.length) {
			this.cache.clear();
			return [];
		}
		const pageNumbers = new Set(pages.map((page) => page.number));
		for (const number of this.cache.keys()) if (!pageNumbers.has(number)) this.cache.delete(number);
		if (scale <= 0) return [];
		const origin = host.getBoundingClientRect().top;
		const elements = new Map(
			Array.from(host.querySelectorAll<HTMLElement>('[data-page-number]')).map((element) => [
				Number(element.dataset.pageNumber),
				element
			])
		);
		const mounted: { cached: CachedPage; top: number }[] = [];
		for (const page of pages) {
			const element = elements.get(page.number);
			if (!element) continue;
			const bounds = element.getBoundingClientRect();
			if (!bounds.height) continue;
			let cached = this.cache.get(page.number);
			if (!cached || cached.page !== page || cached.element !== element) {
				const tokens = Array.from(
					element.querySelectorAll<HTMLElement>('[data-contract-token]')
				).flatMap((span) => {
					try {
						const visualSource: SourceTarget | undefined = span.dataset.visualSource
							? JSON.parse(span.dataset.visualSource)
							: undefined;
						const range: SourceRange | undefined = visualSource
							? isTextTarget(visualSource)
								? visualSource.range
								: undefined
							: {
									start: {
										sourceKey: span.dataset.sourceStartKey!,
										offset: Number(span.dataset.sourceStartOffset)
									},
									end: {
										sourceKey: span.dataset.sourceEndKey!,
										offset: Number(span.dataset.sourceEndOffset)
									}
								};
						if (!range) return [];
						return [
							{
								span,
								start: pointPosition(index, range.start),
								end: pointPosition(index, range.end),
								containerKey: index.byKey.get(range.start.sourceKey)!.containerKey,
								generated: Boolean(span.dataset.visualSource)
							}
						];
					} catch {
						return [];
					}
				});
				tokens.sort((a, b) => a.start - b.start);
				let maxEnd = -Infinity;
				const maxEnds = tokens.map((token) => (maxEnd = Math.max(maxEnd, token.end)));
				const containers = new Map<string, Token[]>();
				for (const token of tokens) {
					const local = containers.get(token.containerKey);
					if (local) local.push(token);
					else containers.set(token.containerKey, [token]);
				}
				cached = {
					page,
					element,
					tokens,
					maxEnds,
					containers,
					boundaries: new Map(
						Array.from(
							element.querySelectorAll<HTMLElement>('[data-structural-boundary]')
						).flatMap((target) =>
							target.dataset.structuralBoundary ? [[target.dataset.structuralBoundary, target]] : []
						)
					),
					projections: [],
					fallbacks: new Map()
				};
				this.cache.set(page.number, cached);
			}
			if (cached.geometryKey !== geometryKey) {
				cached.geometryKey = geometryKey;
				cached.fallbacks.clear();
				cached.projections = this.locations.map((location) => {
					if (location.kind === 'boundary') {
						const target = cached.boundaries.get(location.afterBlockKey);
						const rect = target?.getBoundingClientRect();
						return {
							generated: false,
							...(rect?.height ? { target: (rect.top - bounds.top) / scale } : {})
						};
					}
					const { start, end } = location;
					const projection: Projection = { generated: false };
					for (let t = firstCandidate(cached, start); t < cached.tokens.length; t++) {
						const token = cached.tokens[t];
						if (token.start > end) break;
						const inserted =
							start === end && token.generated && token.start === start && token.end === end;
						projection.generated ||= inserted;
						const overlaps =
							start === end
								? token.start <= start && token.end >= end
								: token.start === token.end
									? token.start >= start && token.start < end
									: token.start < end && token.end > start;
						if (!overlaps) continue;
						if (token.top === undefined) {
							const rect = token.span.getClientRects()[0];
							token.top = rect?.height ? (rect.top - bounds.top) / scale : null;
						}
						if (token.top === null) continue;
						projection.target = Math.min(projection.target ?? Infinity, token.top);
						if (inserted)
							projection.insertedTarget = Math.min(
								projection.insertedTarget ?? Infinity,
								token.top
							);
					}
					return projection;
				});
			}
			mounted.push({ cached, top: bounds.top - origin });
		}
		const anchors: ReviewAnchor[] = [];
		this.locations.forEach((location, i) => {
			// Generated insertion text takes precedence globally, including at page boundaries.
			const inserted = mounted.some(({ cached }) => cached.projections[i].generated);
			const add = (cached: CachedPage, top: number, local: number) => {
				const target = top + local * scale;
				anchors.push({
					key: location.key,
					itemId: location.itemId,
					order: location.start,
					page: cached.page.number,
					target,
					top: target
				});
			};
			// Each concession has one tab, even when its main edit spans pages.
			for (const { cached, top } of mounted) {
				const projection = cached.projections[i];
				const local = inserted ? projection.insertedTarget : projection.target;
				if (local !== undefined) {
					add(cached, top, local);
					return;
				}
			}
			let nearest: { cached: CachedPage; top: number; fallback: Fallback } | undefined;
			if (location.kind === 'boundary') return;
			const { range, start } = location;
			const key = JSON.stringify(range.start);
			for (const { cached, top } of mounted) {
				if (!cached.fallbacks.has(key)) {
					const rect = sourcePointBounds(cached.element, range.start, true);
					const bounds = cached.element.getBoundingClientRect();
					let fallback: Fallback | null = null;
					if (rect && rect.top >= bounds.top && rect.top < bounds.bottom)
						fallback = { target: (rect.top - bounds.top) / scale, distance: -1 };
					else {
						// Numbered paragraphs trim source whitespace. Find the nearest
						// visible token in this passage, once per immutable page and point.
						const unit = index.byKey.get(range.start.sourceKey)!;
						for (const token of cached.containers.get(unit.containerKey) ?? []) {
							const distance = Math.max(token.start - start, start - token.end, 0);
							if (fallback && distance >= fallback.distance) continue;
							if (token.top === undefined) {
								const rect = token.span.getClientRects()[0];
								token.top = rect?.height ? (rect.top - bounds.top) / scale : null;
							}
							if (token.top !== null) fallback = { target: token.top, distance };
						}
					}
					cached.fallbacks.set(key, fallback);
				}
				const fallback = cached.fallbacks.get(key);
				if (!fallback) continue;
				if (fallback.distance < 0) {
					add(cached, top, fallback.target);
					return;
				}
				if (!nearest || fallback.distance < nearest.fallback.distance)
					nearest = { cached, top, fallback };
			}
			if (nearest) add(nearest.cached, nearest.top, nearest.fallback.target);
		});
		anchors.sort(
			(a, b) =>
				a.page - b.page || a.target - b.target || a.order - b.order || a.key.localeCompare(b.key)
		);
		let previousBottom = -Infinity;
		for (const anchor of anchors) {
			anchor.top = Math.max(anchor.target - 8, previousBottom + 5);
			previousBottom = anchor.top + 34;
		}
		return anchors;
	}
}
