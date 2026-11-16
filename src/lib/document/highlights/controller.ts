import {
	buildLineMaps,
	selectionTextHit,
	rangePageNumbers,
	selectedLineBounds,
	measureRanges,
	measureStructuralBoundaryTarget,
	measureRevisions,
	structuralBoundaryHighlight,
	structuralBoundaryRect,
	resolveOverlaps,
	type PageGeometry,
	type HighlightKind,
	type MeasuredInterval,
	type HighlightRect,
	type StructuralBoundaryTarget
} from './geometry';
import { countOverlayWork } from '../runtime/render-perf';
import { getDocumentViewportMetrics } from '../document-viewport';
import { characterBounds } from '../character-bounds';

type GeometryChange = 'invalidate' | 'measure' | 'project';

const controllers = new WeakMap<HTMLElement, DocumentHighlightController>();

export function getDocumentHighlights(
	target: HTMLElement | undefined
): DocumentHighlightController | undefined {
	if (!target) return;
	const stage = target.matches('.document-stage')
		? target
		: (target.closest<HTMLElement>('.document-stage') ??
			target.querySelector<HTMLElement>('.document-stage'));
	return stage ? controllers.get(stage) : undefined;
}

type PageRecord = {
	geometry: PageGeometry;
	revisions: MeasuredInterval[];
	groups: Map<string, Map<Range, MeasuredInterval[]>>;
};
type ObservedContent = { number: number; width: number; height: number };
function contentDimensions(element: Element) {
	const style = getComputedStyle(element);
	const borderBox = style.boxSizing === 'border-box';
	return {
		width:
			parseFloat(style.width) +
			(borderBox
				? 0
				: parseFloat(style.paddingLeft) +
					parseFloat(style.paddingRight) +
					parseFloat(style.borderLeftWidth) +
					parseFloat(style.borderRightWidth)),
		height:
			parseFloat(style.height) +
			(borderBox
				? 0
				: parseFloat(style.paddingTop) +
					parseFloat(style.paddingBottom) +
					parseFloat(style.borderTopWidth) +
					parseFloat(style.borderBottomWidth))
	};
}
type RangeEndpoints = Pick<Range, 'startContainer' | 'startOffset' | 'endContainer' | 'endOffset'>;
type RangeRecord = RangeEndpoints & {
	pages: ReadonlySet<number>;
	membership: ReadonlySet<number>;
	railAnchor?: { geometry: PageGeometry; rect: DOMRect | null };
};
function rangeEndpoints(range: Range): RangeEndpoints {
	return {
		startContainer: range.startContainer,
		startOffset: range.startOffset,
		endContainer: range.endContainer,
		endOffset: range.endOffset
	};
}
function sameRange(range: Range, cached: RangeEndpoints) {
	return (
		range.startContainer === cached.startContainer &&
		range.startOffset === cached.startOffset &&
		range.endContainer === cached.endContainer &&
		range.endOffset === cached.endOffset
	);
}
function sameHighlights(a: readonly HighlightRect[], b: readonly HighlightRect[]) {
	return (
		a.length === b.length &&
		a.every((rect, i) => {
			const other = b[i];
			return (
				rect.page === other.page &&
				rect.x === other.x &&
				rect.y === other.y &&
				rect.width === other.width &&
				rect.height === other.height &&
				rect.kind === other.kind &&
				rect.triggerState === other.triggerState
			);
		})
	);
}
type Group = {
	kind: HighlightKind;
	owner?: HTMLElement;
	rebindFromSource: boolean;
	ranges: Map<Range, RangeRecord>;
	pages?: ReadonlySet<number>;
};
type BoundarySelection = {
	key: string;
};
type BoundaryGroup = {
	kind: HighlightKind;
	selections: readonly BoundarySelection[];
	rects: readonly HighlightRect[];
	pages: ReadonlySet<number>;
};
function groupRangePages(range: Range, included?: ReadonlySet<number>) {
	const pages = rangePageNumbers(range);
	return new Set(included ? pages.filter((number) => included.has(number)) : pages);
}
function samePages(a: ReadonlySet<number>, b: ReadonlySet<number>) {
	return a.size === b.size && [...a].every((number) => b.has(number));
}
export type PageHighlights = ReadonlyMap<number, readonly HighlightRect[]>;
export const EMPTY_HIGHLIGHTS: readonly HighlightRect[] = Object.freeze([]);

export class DocumentHighlightController {
	#stage: HTMLElement;
	#groups = new Map<string, Group>();
	#boundaryGroups = new Map<string, BoundaryGroup>();
	#structuralBoundaries = new Map<string, StructuralBoundaryTarget>();
	#boundaryElements = new Map<string, HTMLElement>();
	/** Range ownership survives unmeasured and dirty page geometry. */
	#pageGroups = new Map<number, Map<string, Set<Range>>>();
	#pages = new Map<number, PageRecord>();
	#publication: PageHighlights = new Map();
	#retainedHighlightPages = new Set<number>();
	#listeners = new Set<(pages: PageHighlights) => void>();
	#hoveredAnnotationId: string | null = null;
	#geometryListeners = new Set<(change: GeometryChange) => void>();
	#annotationRebindListeners = new Set<(pages: ReadonlySet<number>) => void>();
	#layoutEpoch: string | undefined;
	/** Synchronous measurement always drains dirty pages from the latest committed DOM. */
	#geometryDirty = new Set<number>();
	#pageElements = new Map<number, HTMLElement>();
	#visiblePages = new Set<number>();
	#eagerPages = new Set<number>();
	#eagerPageListeners = new Set<(pages: ReadonlySet<number>) => void>();
	#visibilityDirty = true;
	#projectionDirty = false;
	#geometryMeasured = false;
	#paintDirty = new Set<number>();
	#selectionDirty = true;
	#nativeRanges: Range[] = [];
	#selectionProjection: readonly Range[] | null = null;
	#frame: number | undefined;
	#destroyed = false;
	#measurementBatchSize: number;
	#events = new AbortController();
	#resize: ResizeObserver;
	#intersection: IntersectionObserver;
	#mutations: MutationObserver;
	#observed = new Map<Element, ObservedContent>();

	constructor(stage: HTMLElement, { measurementBatchSize = Infinity } = {}) {
		this.#stage = stage;
		this.#measurementBatchSize = measurementBatchSize;
		controllers.set(stage, this);
		const options = { signal: this.#events.signal };
		document.addEventListener('selectionchange', this.#selectionChanged, options);
		const header = document.querySelector('[data-app-header]');
		this.#resize = new ResizeObserver((entries) => {
			const changed = new Set<number>();
			for (const entry of entries) {
				if (entry.target === header) {
					this.projectionChanged();
					continue;
				}
				const previous = this.#observed.get(entry.target);
				if (!previous) continue;
				const size = entry.borderBoxSize[0];
				const { width, height } = size
					? { width: size.inlineSize, height: size.blockSize }
					: contentDimensions(entry.target);
				if (Math.abs(previous.width - width) > 0.01 || Math.abs(previous.height - height) > 0.01) {
					previous.width = width;
					previous.height = height;
					changed.add(previous.number);
				}
			}
			this.#invalidatePages([...changed]);
		});
		if (header) this.#resize.observe(header, { box: 'border-box' });
		this.#intersection = new IntersectionObserver((entries) => {
			let changed = false;
			for (const entry of entries) {
				const number = Number((entry.target as HTMLElement).dataset.pageNumber);
				if (this.#pageElements.get(number) !== entry.target) continue;
				if (entry.isIntersecting && entry.intersectionRect.height > 0) {
					if (!this.#visiblePages.has(number)) {
						this.#visiblePages.add(number);
						changed = true;
					}
				} else changed = this.#visiblePages.delete(number) || changed;
			}
			if (changed) {
				this.#updateEagerPages();
				this.#schedule();
			}
		});
		this.#mutations = new MutationObserver((records) => {
			const geometry = new Set<number>();
			for (const record of records) {
				const element =
					record.target instanceof Element ? record.target : record.target.parentElement;
				const page = element?.closest<HTMLElement>('.document-page');
				if (
					element?.closest('[data-annotation-layer]') ||
					(record.type === 'childList' &&
						[...record.addedNodes, ...record.removedNodes].every(
							(node) => node instanceof HTMLElement && node.hasAttribute('data-annotation-layer')
						))
				)
					continue;
				if (!page) continue;
				const number = Number(page.dataset.pageNumber);
				if (record.type === 'attributes') {
					if (record.oldValue === element?.getAttribute(record.attributeName!)) continue;
					if (record.attributeName === 'data-annotation-selected') {
						this.#paintDirty.add(number);
						continue;
					}
				}
				geometry.add(number);
			}
			if (geometry.size) this.#invalidatePages([...geometry]);
			else this.#schedule();
		});
		this.#observeContent();
		window.addEventListener('resize', this.projectionChanged, options);
		this.#schedule();
	}

	setGroup(
		name: string,
		kind: HighlightKind,
		ranges: readonly Range[],
		includedPages?: ReadonlySet<number>,
		owner?: HTMLElement,
		{ rebindFromSource = false }: { rebindFromSource?: boolean } = {}
	) {
		if (this.#destroyed) return;
		let group = this.#groups.get(name);
		if (group && group.kind !== kind) {
			this.clearGroup(name);
			group = undefined;
		}
		const next = new Set(
			ranges.filter(
				(range) =>
					this.#stage.contains(range.startContainer) && this.#stage.contains(range.endContainer)
			)
		);
		if (!group && !next.size) return;
		if (!group)
			this.#groups.set(name, (group = { kind, ranges: new Map(), owner, rebindFromSource }));
		group.owner = owner;
		group.rebindFromSource = rebindFromSource;
		group.pages = includedPages ? new Set(includedPages) : undefined;
		if (next.size === group.ranges.size) {
			const previous = [...group.ranges.values()];
			if (
				[...next].every((range, i) => {
					const record = previous[i],
						pages = groupRangePages(range, includedPages);
					return sameRange(range, record) && samePages(pages, record.pages);
				})
			)
				return;
		}
		let changed = false;
		for (const [range, record] of group.ranges) {
			if (next.has(range)) continue;
			this.#dropRange(name, group, range, record);
			changed = true;
		}
		for (const range of next) {
			if (this.#updateRange(name, group, range)) changed = true;
		}
		if (changed) this.#schedule();
	}
	/** Paint structural selections that have source coordinates but no text Range. */
	setStructuralBoundaryGroup(
		name: string,
		kind: HighlightKind,
		selections: readonly BoundarySelection[]
	) {
		if (this.#destroyed) return;
		const next = selections.filter((selection) => selection.key);
		if (!next.length) {
			this.clearStructuralBoundaryGroup(name);
			return;
		}
		const previous = this.#boundaryGroups.get(name);
		if (
			previous?.kind === kind &&
			previous.selections.length === next.length &&
			previous.selections.every((selection, index) => selection.key === next[index].key)
		)
			return;
		for (const rect of previous?.rects ?? []) this.#paintDirty.add(rect.page);
		this.#boundaryGroups.set(name, {
			kind,
			selections: next.map((selection) => ({ ...selection })),
			rects: [],
			pages: new Set()
		});
		this.#refreshStructuralBoundaryGroup(name);
	}
	clearStructuralBoundaryGroup(name: string) {
		const group = this.#boundaryGroups.get(name);
		if (!group) return;
		this.#boundaryGroups.delete(name);
		for (const rect of group.rects) this.#paintDirty.add(rect.page);
		this.#pruneStructuralBoundaries();
		this.#schedule();
	}
	structuralBoundary(key: string): StructuralBoundaryTarget | null {
		if (this.#destroyed) return null;
		const target = this.#structuralBoundaries.get(key) ?? this.#structuralBoundaryTarget(key);
		return target ? (this.#projectStructuralBoundary(target) ?? null) : null;
	}
	structuralBoundarySelectionBounds(key: string): DOMRect | null {
		const target = this.#structuralBoundaries.get(key) ?? this.#structuralBoundaryTarget(key);
		if (!target) return null;
		const projection = this.#pageProjection(target.page);
		if (!projection) return null;
		const highlight = structuralBoundaryRect(target);
		return new DOMRect(
			projection.bounds.left + highlight.x * projection.scale,
			projection.bounds.top + highlight.y * projection.scale,
			highlight.width * projection.scale,
			highlight.height * projection.scale
		);
	}
	#pageProjection(number: number) {
		const page = this.#pageElements.get(number);
		if (!page) return null;
		const bounds = page.getBoundingClientRect();
		const scale = bounds.width / page.offsetWidth;
		if (!Number.isFinite(scale) || scale <= 0) return null;
		return { bounds, scale };
	}
	#projectStructuralBoundary(
		target: StructuralBoundaryTarget,
		projection = this.#pageProjection(target.page)
	): StructuralBoundaryTarget | null {
		if (!projection) return null;
		return {
			...target,
			bounds: new DOMRect(
				projection.bounds.left + target.left * projection.scale,
				projection.bounds.top + target.top * projection.scale,
				target.width * projection.scale,
				target.height * projection.scale
			)
		};
	}
	#measureStructuralBoundary(element: HTMLElement): StructuralBoundaryTarget | null {
		const target = measureStructuralBoundaryTarget(element);
		if (!target) return null;
		this.#structuralBoundaries.set(target.key, target);
		return this.#projectStructuralBoundary(target);
	}
	#structuralBoundaryTarget(key: string) {
		const cached = this.#structuralBoundaries.get(key);
		if (cached) return cached;
		const element = this.#boundaryElements.get(key);
		if (element) this.#measureStructuralBoundary(element);
		return this.#structuralBoundaries.get(key);
	}
	#pruneStructuralBoundaries() {
		const retained = new Set(
			[...this.#boundaryGroups.values()].flatMap((group) =>
				group.selections.map((selection) => selection.key)
			)
		);
		for (const key of this.#structuralBoundaries.keys())
			if (!retained.has(key)) this.#structuralBoundaries.delete(key);
	}
	#refreshStructuralBoundaryGroup(name: string) {
		const group = this.#boundaryGroups.get(name);
		if (!group) return;
		const pages = new Set<number>();
		const rects = group.selections.flatMap((selection) => {
			const element = this.#boundaryElements.get(selection.key);
			const number = Number(element?.closest<HTMLElement>('.document-page')?.dataset.pageNumber);
			if (!this.#eagerPages.has(number)) return [];
			const target = this.#structuralBoundaryTarget(selection.key);
			if (target) pages.add(target.page);
			return target ? [structuralBoundaryHighlight(target, group.kind)] : [];
		});
		if (sameHighlights(group.rects, rects) && samePages(group.pages, pages)) return;
		for (const rect of group.rects) this.#paintDirty.add(rect.page);
		group.rects = rects;
		group.pages = pages;
		for (const rect of rects) this.#paintDirty.add(rect.page);
		this.#schedule();
	}
	#refreshStructuralBoundaryGroups() {
		for (const name of this.#boundaryGroups.keys()) this.#refreshStructuralBoundaryGroup(name);
	}
	#updateRange(name: string, group: Group, range: Range, measuredPages?: ReadonlySet<number>) {
		const previous = group.ranges.get(range);
		const endpointsUnchanged = previous !== undefined && sameRange(range, previous);
		if (endpointsUnchanged && measuredPages) {
			for (const number of measuredPages)
				if (previous.pages.has(number)) this.#addRange(number, name, group.kind, range);
			return false;
		}
		const membership = new Set(rangePageNumbers(range));
		const includedPages = group.pages;
		const pages = includedPages
			? new Set([...membership].filter((number) => includedPages.has(number)))
			: membership;
		if (
			endpointsUnchanged &&
			samePages(pages, previous.pages) &&
			samePages(membership, previous.membership)
		)
			return false;
		if (previous) {
			this.#removeRange(
				name,
				range,
				[...previous.pages].filter((number) => !endpointsUnchanged || !pages.has(number))
			);
			this.#indexRange(name, range, previous.membership, false);
		}
		group.ranges.set(range, { ...rangeEndpoints(range), pages, membership });
		this.#indexRange(name, range, membership, true);
		// Retain contributions on unchanged pages, except when their glyph map was rebuilt.
		for (const number of pages)
			if (!endpointsUnchanged || !previous?.pages.has(number) || measuredPages?.has(number))
				this.#addRange(number, name, group.kind, range);
		return true;
	}
	#indexRange(name: string, range: Range, pages: Iterable<number>, add: boolean) {
		for (const number of pages) {
			let groups = this.#pageGroups.get(number);
			let ranges = groups?.get(name);
			if (add) {
				if (!groups) this.#pageGroups.set(number, (groups = new Map()));
				if (!ranges) groups.set(name, (ranges = new Set()));
				ranges.add(range);
			} else {
				ranges?.delete(range);
				if (!ranges?.size) groups?.delete(name);
				if (!groups?.size) this.#pageGroups.delete(number);
			}
		}
	}
	#dropRange(name: string, group: Group, range: Range, record: RangeRecord) {
		this.#removeRange(name, range, record.pages);
		this.#indexRange(name, range, record.membership, false);
		group.ranges.delete(range);
	}
	#removeRange(name: string, range: Range, pages: Iterable<number>) {
		for (const number of pages) {
			this.#pages.get(number)?.groups.get(name)?.delete(range);
			this.#paintDirty.add(number);
		}
	}
	#addRange(number: number, name: string, kind: HighlightKind, range: Range) {
		const page = this.#pages.get(number);
		if (page && !this.#geometryDirty.has(number)) {
			let contributions = page.groups.get(name);
			if (!contributions) page.groups.set(name, (contributions = new Map()));
			const owner = this.#groups.get(name)?.owner;
			contributions.set(
				range,
				measureRanges([page.geometry], [range], kind).map((interval) =>
					owner ? { ...interval, owner, annotationIds: [owner.dataset.annotationId!] } : interval
				)
			);
		}
		this.#paintDirty.add(number);
	}
	#refreshPageRanges(pages: ReadonlySet<number>, measured = false) {
		const affected = new Map<string, Map<Range, Set<number>>>();
		for (const number of pages) {
			for (const [name, ranges] of this.#pageGroups.get(number) ?? []) {
				let collected = affected.get(name);
				if (!collected) affected.set(name, (collected = new Map()));
				for (const range of ranges) {
					let numbers = collected.get(range);
					if (!numbers) collected.set(range, (numbers = new Set()));
					numbers.add(number);
				}
			}
		}
		const rebindPages = new Set<number>();
		const invalid = new Map<string, Map<Range, RangeRecord>>();
		for (const [name, ranges] of affected) {
			const group = this.#groups.get(name);
			if (!group?.rebindFromSource) continue;
			for (const range of ranges.keys()) {
				const record = group.ranges.get(range);
				if (
					!record ||
					(!range.collapsed &&
						sameRange(range, record) &&
						this.#stage.contains(range.startContainer) &&
						this.#stage.contains(range.endContainer))
				)
					continue;
				let entries = invalid.get(name);
				if (!entries) invalid.set(name, (entries = new Map()));
				entries.set(range, record);
				for (const number of record.pages) rebindPages.add(number);
			}
		}
		// Recreate source-owned ranges before the next frame can publish empty geometry.
		if (rebindPages.size)
			for (const listener of this.#annotationRebindListeners) listener(rebindPages);
		for (const [name, ranges] of affected) {
			const group = this.#groups.get(name);
			if (!group) continue;
			for (const [range, numbers] of ranges) {
				if (invalid.get(name)?.has(range)) continue;
				const record = group.ranges.get(range);
				if (!record) continue;
				if (
					!this.#stage.contains(range.startContainer) ||
					!this.#stage.contains(range.endContainer)
				) {
					this.#dropRange(name, group, range, record);
				} else this.#updateRange(name, group, range, measured ? numbers : undefined);
			}
		}
		for (const [name, ranges] of invalid) {
			const group = this.#groups.get(name);
			if (!group) continue;
			for (const [range, record] of ranges)
				if (group.ranges.get(range) === record) this.#dropRange(name, group, range, record);
		}
	}
	clearGroup(name: string) {
		const group = this.#groups.get(name);
		if (!group) return;
		for (const [range, record] of group.ranges) this.#dropRange(name, group, range, record);
		this.#groups.delete(name);
		this.#schedule();
	}
	/** Reuse measured line maps for out-of-flow annotation semantics and focus bounds. */
	annotationBounds(name: string) {
		const result: HighlightRect[] = [];
		const numbers = new Set<number>();
		for (const record of this.#groups.get(name)?.ranges.values() ?? [])
			for (const number of record.pages) numbers.add(number);
		for (const number of numbers) {
			if (this.#geometryDirty.has(number)) continue;
			const page = this.#pages.get(number);
			for (const intervals of page?.groups.get(name)?.values() ?? [])
				for (const interval of intervals)
					result.push({
						page: number,
						x: interval.left,
						y: interval.band.y,
						width: interval.right - interval.left,
						height: interval.band.height,
						kind: interval.kind
					});
		}
		return result;
	}
	/** Match text-card anchors without changing highlight bands or measuring cold pages. */
	annotationAnchorRect(name: string): DOMRect | undefined {
		for (const [range, record] of this.#groups.get(name)?.ranges ?? []) {
			const start = range.startContainer;
			const element = (
				start instanceof Element ? start : start.parentElement
			)?.closest<HTMLElement>('.document-page');
			if (!element || !this.#stage.contains(element)) continue;
			const number = Number(element.dataset.pageNumber);
			if (!record.pages.has(number) || this.#pageElements.get(number) !== element) continue;
			const projection = this.#pageProjection(number);
			if (!projection) continue;
			const { bounds, scale } = projection;
			const page = this.#pages.get(number);
			if (page?.geometry.element === element && !this.#geometryDirty.has(number)) {
				if (record.railAnchor?.geometry !== page.geometry) {
					const rect = characterBounds(start, range.startOffset);
					record.railAnchor = {
						geometry: page.geometry,
						rect: rect
							? new DOMRect(
									(rect.left - bounds.left) / scale,
									(rect.top - bounds.top) / scale,
									rect.width / scale,
									rect.height / scale
								)
							: null
					};
				}
				const rect = record.railAnchor.rect;
				if (rect)
					return new DOMRect(
						bounds.left + rect.x * scale,
						bounds.top + rect.y * scale,
						rect.width * scale,
						rect.height * scale
					);
			}
			return new DOMRect(bounds.left, bounds.top, 0, 0);
		}
	}

	annotationsChanged(names: ReadonlySet<string>) {
		for (const name of names)
			for (const range of this.#groups.get(name)?.ranges.values() ?? [])
				for (const page of range.pages) this.#paintDirty.add(page);
		this.#schedule();
	}
	subscribe(listener: (pages: PageHighlights) => void) {
		this.#listeners.add(listener);
		listener(this.#publication);
		return () => {
			this.#listeners.delete(listener);
		};
	}
	/** During a custom drag DOM Selection is output, never a second paint authority. */
	setSelectionProjection(ranges: readonly Range[] | null) {
		if (ranges === null && this.#selectionProjection === null) return;
		if (
			ranges &&
			this.#selectionProjection &&
			ranges.length === this.#selectionProjection.length &&
			ranges.every((range, i) => sameRange(range, this.#selectionProjection![i]))
		)
			return;
		this.#selectionProjection = ranges;
		this.#selectionDirty = true;
		this.#schedule();
	}
	selectionHit(pageElement: HTMLElement, x: number, y: number) {
		const number = Number(pageElement.dataset.pageNumber);
		this.#ensureGeometry(new Set([number]));
		const page = this.#pages.get(number);
		return page?.geometry.element === pageElement && !this.#geometryDirty.has(number)
			? selectionTextHit(page.geometry, x, y)
			: null;
	}
	hitTest(
		pageElement: HTMLElement,
		clientX: number,
		clientY: number,
		accept: (owner: HTMLElement) => boolean = () => true
	): HTMLElement | null {
		if (this.#destroyed) return null;
		const number = Number(pageElement.dataset.pageNumber);
		this.#ensureGeometry(new Set([number]));
		const page = this.#pages.get(number);
		if (this.#geometryDirty.has(number) || page?.geometry.element !== pageElement) return null;
		const bounds = pageElement.getBoundingClientRect(),
			scale = bounds.width / pageElement.offsetWidth;
		if (
			!scale ||
			clientX < bounds.left ||
			clientX >= bounds.right ||
			clientY < bounds.top ||
			clientY >= bounds.bottom
		)
			return null;
		const x = (clientX - bounds.left) / scale,
			y = (clientY - bounds.top) / scale;
		return (
			[
				...[...page.groups.values()]
					.flatMap((ranges) => [...ranges.values()].flat())
					.filter((interval) => interval.owner)
			]
				.sort(
					(a, b) =>
						Number(a.owner?.dataset.annotationPriority ?? 0) -
							Number(b.owner?.dataset.annotationPriority ?? 0) ||
						(a.owner?.dataset.annotationId ?? '').localeCompare(b.owner?.dataset.annotationId ?? '')
				)
				.find(
					(interval) =>
						interval.owner?.isConnected &&
						accept(interval.owner) &&
						x >= interval.left &&
						x < interval.right &&
						y >= interval.band.y &&
						y < interval.band.y + interval.band.height
				)?.owner ?? null
		);
	}
	setHoveredAnnotationId(annotationId: string | null) {
		if (this.#destroyed || this.#hoveredAnnotationId === annotationId) return;
		for (const [number, page] of this.#pages) {
			const projected = [...page.groups.keys()].some((name) => {
				const id = this.#groups.get(name)?.owner?.dataset.annotationId;
				return id === this.#hoveredAnnotationId || id === annotationId;
			});
			if (projected) this.#paintDirty.add(number);
		}
		this.#hoveredAnnotationId = annotationId;
		this.#schedule();
	}
	subscribeGeometry(listener: (change: GeometryChange) => void) {
		this.#geometryListeners.add(listener);
		return () => {
			this.#geometryListeners.delete(listener);
		};
	}
	subscribeAnnotationRebind(listener: (pages: ReadonlySet<number>) => void) {
		this.#annotationRebindListeners.add(listener);
		return () => {
			this.#annotationRebindListeners.delete(listener);
		};
	}
	/** Visible pages and one neighbor on each side, shared with search materialization. */
	subscribeEagerPages(listener: (pages: ReadonlySet<number>) => void) {
		this.#eagerPageListeners.add(listener);
		listener(new Set(this.#eagerPages));
		return () => {
			this.#eagerPageListeners.delete(listener);
		};
	}
	#notifyGeometry(change: GeometryChange) {
		countOverlayWork('geometryNotifications');
		for (const listener of this.#geometryListeners) listener(change);
	}
	/** Project text geometry; gutter controls keep a fixed screen size as the page scales. */
	projectionChanged = () => {
		if (this.#destroyed) return;
		this.#structuralBoundaries.clear();
		this.#refreshStructuralBoundaryGroups();
		this.#visibilityDirty = true;
		this.#projectionDirty = true;
		this.#schedule();
	};
	ensureRangeGeometry(range: Range) {
		if (this.#destroyed) return;
		this.#ensureGeometry(new Set(rangePageNumbers(range)));
	}
	#selectionChanged = () => {
		if (this.#selectionProjection !== null) return;
		if (!this.#selectionDirty) {
			const selection = document.getSelection();
			const ranges =
				selection && !selection.isCollapsed
					? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i)).filter(
							(range) =>
								this.#stage.contains(range.startContainer) &&
								this.#stage.contains(range.endContainer)
						)
					: [];
			if (
				ranges.length === this.#nativeRanges.length &&
				ranges.every((range, i) => sameRange(range, this.#nativeRanges[i]))
			)
				return;
		}
		this.#selectionDirty = true;
		this.#schedule();
	};
	#measureSelection(ranges: Range[]) {
		ranges = ranges.filter(
			(range) =>
				this.#stage.contains(range.startContainer) && this.#stage.contains(range.endContainer)
		);
		const unchanged =
			ranges.length === this.#nativeRanges.length &&
			ranges.every((range, i) => sameRange(range, this.#nativeRanges[i]));
		if (!unchanged) this.#nativeRanges = ranges.map((range) => range.cloneRange());
		this.setGroup(
			'native-selection',
			this.#selectionProjection !== null ? 'authoring-selection' : 'native-selection',
			this.#nativeRanges,
			this.#eagerPages
		);
		this.#selectionDirty = false;
	}
	/**
	 * The highlighter is the sole text-geometry owner. Consumers can position transient controls
	 * from the same line maps used to paint selection highlights without repeating DOM rect scans.
	 */
	rangeBounds(ranges: readonly Range[]): DOMRect | null {
		if (this.#destroyed) return null;
		const owned = ranges.filter(
			(range) =>
				this.#stage.contains(range.startContainer) && this.#stage.contains(range.endContainer)
		);
		if (!owned.length) return null;
		// Bounds need endpoint pages and already-visible pages, never every page in a long range.
		const pages = new Set(
			owned.flatMap((range) => {
				const numbers = rangePageNumbers(range);
				return numbers.filter(
					(number, i) => i === 0 || i === numbers.length - 1 || this.#eagerPages.has(number)
				);
			})
		);
		this.#ensureGeometry(pages);
		const intervals = [...pages]
			.sort((a, b) => a - b)
			.flatMap((number) => {
				const page = this.#pages.get(number);
				return page && !this.#geometryDirty.has(number)
					? measureRanges(
							[page.geometry],
							owned,
							this.#selectionProjection !== null ? 'authoring-selection' : 'native-selection'
						)
					: [];
			});
		return selectedLineBounds(intervals);
	}
	contentCommitted(layoutEpoch: string, changedPages: readonly number[]) {
		if (this.#destroyed) return;
		const previousEpoch = this.#layoutEpoch;
		this.#layoutEpoch = layoutEpoch;
		// Group ownership can move across an unchanged page's edge on a new model.
		// Text geometry still reuses exact prepared pages; structural targets rebind lazily.
		this.#structuralBoundaries.clear();
		this.#observeContent();
		if (previousEpoch === layoutEpoch)
			for (const number of changedPages)
				if (
					this.#pages.get(number)?.geometry.element === this.#pageElements.get(number) &&
					this.#publication.has(number)
				)
					this.#retainedHighlightPages.add(number);
		this.#invalidatePages(
			previousEpoch !== layoutEpoch ? [...this.#pageElements.keys()] : changedPages
		);
		this.#visibilityDirty = true;
		this.#schedule();
	}
	#invalidatePages(pages: readonly number[]) {
		if (this.#destroyed || !pages.length) return;
		const invalidated = new Set(pages);
		for (const [key, target] of this.#structuralBoundaries)
			if (invalidated.has(target.page)) this.#structuralBoundaries.delete(key);
		let changed = false;
		for (const number of pages) {
			if (!this.#pageElements.has(number) || this.#geometryDirty.has(number)) continue;
			this.#geometryDirty.add(number);
			this.#paintDirty.add(number);
			changed = true;
		}
		this.#refreshPageRanges(new Set(pages));
		if (!changed) {
			this.#schedule();
			return;
		}
		this.#selectionDirty = true;
		this.#notifyGeometry('invalidate');
		this.#schedule();
	}
	#observeContent() {
		const elements = new Map(
			Array.from(
				this.#stage.querySelectorAll<HTMLElement>('.document-page'),
				(element) => [Number(element.dataset.pageNumber), element] as const
			)
		);
		const removedPages = new Set<number>();
		for (const [number, element] of this.#pageElements) {
			if (elements.get(number) === element) continue;
			removedPages.add(number);
			this.#selectionDirty = true;
			this.#intersection.unobserve(element);
			this.#visiblePages.delete(number);
			this.#pages.delete(number);
			this.#retainedHighlightPages.delete(number);
			this.#geometryDirty.delete(number);
			this.#paintDirty.add(number);
		}
		for (const [number, element] of elements) {
			if (this.#pageElements.get(number) === element) continue;
			this.#selectionDirty = true;
			this.#intersection.observe(element);
			this.#geometryDirty.add(number);
		}
		this.#pageElements = elements;
		this.#boundaryElements = new Map(
			Array.from(
				this.#stage.querySelectorAll<HTMLElement>('[data-structural-boundary]'),
				(element) => [element.dataset.structuralBoundary!, element]
			)
		);
		for (const [key, target] of this.#structuralBoundaries)
			if (removedPages.has(target.page) || !this.#pageElements.has(target.page))
				this.#structuralBoundaries.delete(key);
		this.#refreshPageRanges(removedPages);
		this.#refreshStructuralBoundaryGroups();
		this.#visibilityDirty = true;
		const contents = new Set(
			this.#stage.querySelectorAll('.document-page, .document-page__content')
		);
		const removed = [...this.#observed.keys()].filter((content) => !contents.has(content));
		for (const content of removed) {
			this.#resize.unobserve(content);
			this.#observed.delete(content);
		}
		// MutationObserver cannot unobserve one target. Reconnect only when pages disappear.
		if (removed.length) this.#mutations.disconnect();
		for (const content of contents) {
			const added = !this.#observed.has(content);
			if (added) {
				const page = content.closest<HTMLElement>('.document-page')!;
				this.#observed.set(content, {
					number: Number(page.dataset.pageNumber),
					...contentDimensions(content)
				});
				this.#resize.observe(content, { box: 'border-box' });
			}
			if ((added || removed.length) && content.matches('.document-page__content'))
				this.#mutations.observe(content, {
					subtree: true,
					childList: true,
					characterData: true,
					attributes: true,
					attributeOldValue: true,
					attributeFilter: [
						'data-annotation-selected',
						'aria-hidden',
						'class',
						'data-revision',
						'data-annotation-id',
						'data-annotation-memberships'
					]
				});
		}
	}
	#updateEagerPages() {
		const eager = new Set(this.#visiblePages);
		const numbers = [...this.#pageElements.keys()];
		for (const [i, number] of numbers.entries()) {
			if (!this.#visiblePages.has(number)) continue;
			if (i > 0) eager.add(numbers[i - 1]);
			if (i + 1 < numbers.length) eager.add(numbers[i + 1]);
		}
		if (
			eager.size === this.#eagerPages.size &&
			[...eager].every((number) => this.#eagerPages.has(number))
		)
			return;
		this.#eagerPages = eager;
		this.#refreshStructuralBoundaryGroups();
		if (this.#groups.has('native-selection')) {
			this.setGroup(
				'native-selection',
				this.#selectionProjection !== null ? 'authoring-selection' : 'native-selection',
				this.#nativeRanges,
				eager
			);
		}
		for (const listener of this.#eagerPageListeners) listener(new Set(eager));
	}
	#updateVisibility() {
		if (!this.#visibilityDirty) return;
		this.#visibilityDirty = false;
		this.#visiblePages.clear();
		const top = getDocumentViewportMetrics().top;
		for (const [number, element] of this.#pageElements) {
			const bounds = element.getBoundingClientRect();
			if (
				bounds.bottom > top &&
				bounds.top < window.innerHeight &&
				bounds.right > 0 &&
				bounds.left < window.innerWidth
			)
				this.#visiblePages.add(number);
		}
		this.#updateEagerPages();
	}
	#measurementTargets() {
		const targets = new Set(this.#eagerPages);
		for (const group of this.#groups.values()) {
			if (
				group.kind !== 'authoring-selection' &&
				group.kind !== 'search-active' &&
				group.owner !== document.activeElement
			)
				continue;
			for (const record of group.ranges.values())
				for (const number of record.pages) targets.add(number);
		}
		for (const group of this.#boundaryGroups.values())
			for (const number of group.pages) targets.add(number);
		return targets;
	}
	#nextMeasurementTarget(targets: ReadonlySet<number>) {
		// Keep the page being read ahead of its neighbors when an opening is still appending.
		for (const number of this.#pageElements.keys())
			if (this.#visiblePages.has(number) && targets.has(number) && this.#geometryDirty.has(number))
				return number;
		for (const number of targets) if (this.#geometryDirty.has(number)) return number;
		return undefined;
	}
	#measurementBatch(targets: ReadonlySet<number>) {
		if (this.#measurementBatchSize === Infinity) return targets;
		const batch = new Set<number>();
		const add = (number: number) => {
			if (targets.has(number) && this.#geometryDirty.has(number)) batch.add(number);
		};
		for (const number of this.#pageElements.keys()) {
			if (this.#visiblePages.has(number)) add(number);
			if (batch.size >= this.#measurementBatchSize) return batch;
		}
		for (const number of targets) {
			add(number);
			if (batch.size >= this.#measurementBatchSize) break;
		}
		return batch;
	}
	setSnapshotComplete(complete: boolean) {
		// Retained, complete documents keep their immediate all-page measurement.
		const size = complete ? (this.#measurementBatchSize === Infinity ? Infinity : 3) : 1;
		if (this.#measurementBatchSize === size) return;
		this.#measurementBatchSize = size;
		this.#schedule();
	}

	#ensureGeometry(targets: ReadonlySet<number>) {
		const pending = new Set([...targets].filter((number) => this.#geometryDirty.has(number)));
		if (!pending.size) return;
		// A synchronous hit/navigation request drains the same page queue as the frame.
		const updated = buildLineMaps(this.#stage, pending);
		countOverlayWork('measuredPages', updated.length);
		countOverlayWork(
			'measuredNodes',
			updated.reduce((count, page) => count + page.textIndex.length, 0)
		);
		for (const number of pending) this.#geometryDirty.delete(number);
		for (const number of pending) this.#retainedHighlightPages.delete(number);
		for (const geometry of updated) {
			this.#pages.set(geometry.number, {
				geometry,
				revisions: measureRevisions([geometry]),
				groups: new Map()
			});
			this.#paintDirty.add(geometry.number);
		}
		this.#refreshStructuralBoundaryGroups();
		// ResizeObserver may deliver the commit's dimension change after this frame.
		// Cache the dimensions used by this measurement so that delivery cannot queue it again.
		for (const [element, observed] of this.#observed) {
			if (!pending.has(observed.number)) continue;
			Object.assign(observed, contentDimensions(element));
		}
		const measuredPages = new Set(updated.map((geometry) => geometry.number));
		this.#refreshPageRanges(measuredPages, true);
		this.#geometryMeasured = updated.length > 0 || this.#geometryMeasured;
		if (updated.length) this.#selectionDirty = true;
		this.#schedule();
	}
	#schedule = () => {
		if (
			this.#destroyed ||
			this.#frame !== undefined ||
			(!this.#visibilityDirty &&
				!this.#projectionDirty &&
				!this.#geometryMeasured &&
				![...this.#measurementTargets()].some((number) => this.#geometryDirty.has(number)) &&
				!this.#selectionDirty &&
				!this.#paintDirty.size)
		)
			return;
		this.#frame = requestAnimationFrame(() => {
			this.#updateVisibility();
			const selection = document.getSelection();
			const ranges =
				this.#selectionProjection !== null
					? [...this.#selectionProjection]
					: selection && !selection.isCollapsed
						? Array.from({ length: selection.rangeCount }, (_, i) =>
								selection.getRangeAt(i)
							).filter(
								(range) =>
									this.#stage.contains(range.startContainer) &&
									this.#stage.contains(range.endContainer)
							)
						: [];
			const targets = this.#measurementTargets();
			this.#ensureGeometry(this.#measurementBatch(targets));
			if (this.#selectionDirty) {
				this.#measureSelection(ranges);
			}
			const projectionChanged = this.#projectionDirty;
			if (projectionChanged) this.#projectionDirty = false;
			if (this.#geometryMeasured) {
				this.#geometryMeasured = false;
				this.#notifyGeometry('measure');
			} else if (projectionChanged) this.#notifyGeometry('project');
			this.#frame = undefined;
			if (this.#paintDirty.size) {
				const publication = new Map(this.#publication);
				let changed = false;
				for (const number of this.#paintDirty) {
					const page = this.#pages.get(number);
					if (!page || this.#geometryDirty.has(number)) {
						if (
							page &&
							this.#retainedHighlightPages.has(number) &&
							page.geometry.element === this.#pageElements.get(number)
						)
							continue;
						changed = publication.delete(number) || changed;
						continue;
					}
					const rects = [
						...resolveOverlaps(
							[
								...page.revisions,
								...[...page.groups.values()].flatMap((ranges) => [...ranges.values()].flat())
							],
							this.#hoveredAnnotationId
						),
						...[...this.#boundaryGroups.values()].flatMap((group) =>
							group.rects.filter((rect) => rect.page === number)
						)
					];
					if (!sameHighlights(publication.get(number) ?? EMPTY_HIGHLIGHTS, rects)) {
						publication.set(number, rects);
						changed = true;
					}
				}
				this.#paintDirty.clear();
				if (changed) {
					this.#publication = publication;
					countOverlayWork('highlightPublications');
					for (const listener of this.#listeners) listener(publication);
				}
			}
			if (this.#nextMeasurementTarget(this.#measurementTargets()) === undefined)
				this.#stage.setAttribute('data-highlights-ready', '');
			if (this.#measurementBatchSize !== Infinity) this.#schedule();
		});
	};
	destroy() {
		this.#destroyed = true;
		if (this.#frame !== undefined) cancelAnimationFrame(this.#frame);
		this.#events.abort();
		this.#resize.disconnect();
		this.#intersection.disconnect();
		this.#mutations.disconnect();
		this.#observed.clear();
		this.#listeners.clear();
		this.#geometryListeners.clear();
		this.#annotationRebindListeners.clear();
		this.#eagerPageListeners.clear();
		this.#groups.clear();
		this.#boundaryGroups.clear();
		this.#structuralBoundaries.clear();
		this.#boundaryElements.clear();
		this.#pageGroups.clear();
		this.#pages.clear();
		this.#retainedHighlightPages.clear();
		this.#pageElements.clear();
		this.#geometryDirty.clear();
		this.#eagerPages.clear();
		this.#visiblePages.clear();
		this.#paintDirty.clear();
		this.#nativeRanges = [];
		this.#publication = new Map();
		this.#hoveredAnnotationId = null;
		controllers.delete(this.#stage);
		this.#stage.removeAttribute('data-highlights-ready');
	}
}
