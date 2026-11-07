import { HIGHLIGHT_THEME, type HighlightKind } from './theme';
import { countSearchWork } from '../runtime/render-perf';

export type { HighlightKind } from './theme';

const TEXT_CONTAINER_SELECTOR = 'p, h1, h2, h3, td, th';

export interface HighlightRect {
	page: number;
	x: number;
	y: number;
	width: number;
	height: number;
	kind: HighlightKind;
	triggerState?: 'default' | 'hover' | 'selected' | 'pending';
}

/**
 * A real structural margin has no DOM range, so it is measured as an explicit page-local target.
 * `bounds` remains in viewport coordinates for pointer input and floating UI positioning.
 */
export interface StructuralBoundaryTarget {
	key: string;
	page: number;
	bounds: DOMRect;
	left: number;
	top: number;
	width: number;
	height: number;
}

export type StructuralBoundaryRect = Pick<HighlightRect, 'x' | 'y' | 'width' | 'height'>;

interface Band {
	y: number;
	height: number;
	center: number;
}
interface TextEntry {
	node: Text;
	length: number;
	rects: TextRect[];
	trigger: HTMLElement | null;
	revision: string | undefined;
	selectable: boolean;
	presentation: boolean;
}
interface TextRect extends Band {
	left: number;
	right: number;
	band: Band;
}
interface TextContainer {
	element: HTMLElement;
	texts: TextEntry[];
	bands: Band[];
	carets: Map<
		Band,
		{ node: Text; offset: number; x: number; affinity: 'upstream' | 'downstream' }[]
	>;
}
export interface PageGeometry {
	element: HTMLElement;
	number: number;
	containers: TextContainer[];
	/** DOM order, including nested text containers and table cells. */
	textIndex: { entry: TextEntry; container: TextContainer }[];
	textPositions: WeakMap<Text, number>;
}

/** Coordinate helper only. Selection state and source validation belong to the document. */
export function selectionTextHit(page: PageGeometry, clientX: number, clientY: number) {
	const { bounds, scale } = pageSpace(page.element);
	if (!scale) return null;
	const x = (clientX - bounds.left) / scale,
		y = (clientY - bounds.top) / scale;
	const distance = (point: number, low: number, high: number) =>
		Math.max(low - point, 0, point - high);
	const populated = (container: TextContainer) =>
		container.bands.length > 0 &&
		container.texts.some((entry) => !entry.presentation && entry.length);
	const regions = new Map<HTMLElement, TextContainer[]>();
	for (const container of page.containers) {
		const region = container.element.closest<HTMLElement>('table') ?? container.element;
		const values = regions.get(region) ?? [];
		values.push(container);
		regions.set(region, values);
	}
	let chosen: { element: HTMLElement; containers: TextContainer[]; distance: number } | undefined;
	for (const [element, containers] of regions) {
		if (!containers.some(populated) && !element.matches('table')) continue;
		const rect = element.getBoundingClientRect();
		const next = distance(clientY, rect.top, rect.bottom);
		if (!chosen || next < chosen.distance) chosen = { element, containers, distance: next };
	}
	if (!chosen) return null;
	const real = page.textIndex.filter(
		({ entry, container }) => !entry.presentation && entry.length && container.bands.length
	);
	if (real.length) {
		const first = real[0],
			last = real.at(-1)!;
		if (
			clientY <
			Math.min(...[...regions.keys()].map((element) => element.getBoundingClientRect().top))
		)
			return { node: first.entry.node, offset: 0, affinity: 'downstream' as const };
		if (
			clientY >
			Math.max(...[...regions.keys()].map((element) => element.getBoundingClientRect().bottom))
		)
			return { node: last.entry.node, offset: last.entry.length, affinity: 'upstream' as const };
	}
	let container = chosen.containers[0];
	if (chosen.element.matches('table')) {
		if (!chosen.containers.some(populated)) return null;
		let bestY = Infinity,
			bestX = Infinity;
		for (const candidate of chosen.containers) {
			const rect = candidate.element.getBoundingClientRect();
			const dy = distance(clientY, rect.top, rect.bottom),
				dx = distance(clientX, rect.left, rect.right);
			if (dy < bestY || (dy === bestY && dx < bestX)) {
				container = candidate;
				bestY = dy;
				bestX = dx;
			}
		}
		if (!populated(container)) {
			const row = container.element.parentElement;
			const sameRow = chosen.containers.filter(
				(candidate) => candidate.element.parentElement === row && populated(candidate)
			);
			const candidates = sameRow.length ? sameRow : chosen.containers.filter(populated);
			let nearest = Infinity;
			for (const candidate of candidates) {
				const rect = candidate.element.getBoundingClientRect();
				const d = Math.hypot(
					distance(clientX, rect.left, rect.right),
					distance(clientY, rect.top, rect.bottom)
				);
				if (d < nearest) {
					nearest = d;
					container = candidate;
				}
			}
		}
	}
	const band = nearestBand(container.bands, y);
	if (!band) return null;
	const insideBand = (rect: DOMRect) =>
		rect.height > 0 &&
		Math.abs((rect.top + rect.height / 2 - bounds.top) / scale - band.center) < band.height / 2;
	const doc = page.element.ownerDocument as Document & {
		caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
		caretRangeFromPoint?: (x: number, y: number) => Range | null;
	};
	const regionRect = container.element.getBoundingClientRect();
	const probeX = Math.max(regionRect.left, Math.min(regionRect.right, clientX)),
		probeY = bounds.top + band.center * scale;
	const position = doc.caretPositionFromPoint?.(probeX, probeY),
		nativeRange = position ? null : doc.caretRangeFromPoint?.(probeX, probeY);
	const node = position?.offsetNode ?? nativeRange?.startContainer,
		offset = position?.offset ?? nativeRange?.startOffset;
	if (
		node?.nodeType === Node.TEXT_NODE &&
		offset !== undefined &&
		container.texts.some((entry) => !entry.presentation && entry.node === node)
	) {
		const caret = doc.createRange();
		caret.setStart(node, offset);
		caret.collapse(true);
		if (Array.from(caret.getClientRects()).some(insideBand))
			return { node: node as Text, offset, affinity: 'downstream' as const };
	}
	// Lazy actual caret rectangles belong to the existing page geometry, including bidi/wrap edges.
	let carets = container.carets.get(band);
	if (!carets) {
		carets = [];
		const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
		for (const [i, entry] of container.texts.entries()) {
			if (entry.presentation) {
				if (!entry.rects.some((rect) => rect.band === band)) continue;
				const next = container.texts.slice(i + 1).find((text) => !text.presentation && text.length);
				const previous = container.texts
					.slice(0, i)
					.findLast((text) => !text.presentation && text.length);
				const endpoint = next
					? { node: next.node, offset: 0 }
					: previous
						? { node: previous.node, offset: previous.length }
						: null;
				if (endpoint)
					carets.push({
						...endpoint,
						x: entry.rects[0].left,
						affinity: next ? 'downstream' : 'upstream'
					});
				continue;
			}
			if (!entry.rects.some((rect) => rect.band === band)) continue;
			const offsets = new Set([0, entry.length]);
			for (const part of segmenter.segment(entry.node.data)) {
				offsets.add(part.index);
				offsets.add(part.index + part.segment.length);
			}
			for (const offset of offsets) {
				const caret = doc.createRange();
				caret.setStart(entry.node, offset);
				caret.collapse(true);
				for (const rect of caret.getClientRects())
					if (insideBand(rect))
						carets.push({
							node: entry.node,
							offset,
							x: (rect.left - bounds.left) / scale,
							affinity: offset === entry.length ? 'upstream' : 'downstream'
						});
			}
		}
		container.carets.set(band, carets);
	}
	let nearest: (typeof carets)[number] | undefined;
	for (const caret of carets)
		if (!nearest || Math.abs(caret.x - x) < Math.abs(nearest.x - x)) nearest = caret;
	return nearest
		? { node: nearest.node, offset: nearest.offset, affinity: nearest.affinity }
		: null;
}

export interface MeasuredInterval {
	page: PageGeometry;
	container: TextContainer;
	band: Band;
	left: number;
	right: number;
	kind: HighlightKind;
	owner?: HTMLElement;
	annotationIds?: readonly string[];
}

/** Endpoint ancestors bound membership without probing a range against every page. */
function rangePageInterval(range: Range): [number, number] | undefined {
	const page = (node: Node) =>
		(node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('.document-page');
	const start = page(range.startContainer),
		end = page(range.endContainer);
	if (!start || !end || !start.isConnected || !end.isConnected) return;
	return [Number(start.dataset.pageNumber), Number(end.dataset.pageNumber)];
}

export function rangePageNumbers(range: Range): number[] {
	const interval = rangePageInterval(range);
	if (!interval) return [];
	const [first, last] = interval;
	return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i);
}

function pageSpace(page: HTMLElement) {
	const bounds = page.getBoundingClientRect();
	const scale = bounds.width / page.offsetWidth;
	return { bounds, scale };
}

/** Measure the explicit hit target placed over a source-owned structural margin. */
export function measureStructuralBoundaryTarget(
	target: HTMLElement
): StructuralBoundaryTarget | null {
	const key = target.dataset.structuralBoundary;
	const page = target.closest<HTMLElement>('.document-page');
	const content = target.closest<HTMLElement>('.document-page__content');
	if (!key || !page || !content || !target.isConnected) return null;
	const pageSpace = page.getBoundingClientRect();
	const contentBounds = content.getBoundingClientRect();
	const targetBounds = target.getBoundingClientRect();
	const scale = pageSpace.width / page.offsetWidth;
	if (!Number.isFinite(scale) || scale <= 0) return null;
	// Text gaps are bounded horizontally by the text column. Gutter controls and end-of-page
	// insertion points live outside the content box, but always inside the physical page.
	const gutter = target.classList.contains('structural-boundary-target--gutter');
	const top = Math.max(targetBounds.top, pageSpace.top);
	const bottom = Math.min(targetBounds.bottom, pageSpace.bottom);
	const left = Math.max(
		targetBounds.left,
		gutter ? pageSpace.left : contentBounds.left,
		pageSpace.left
	);
	const right = Math.min(
		targetBounds.right,
		gutter ? pageSpace.right : contentBounds.right,
		pageSpace.right
	);
	if ((bottom - top) / scale < 1 || (right - left) / scale < 1) return null;
	return {
		key,
		page: Number(page.dataset.pageNumber),
		bounds: new DOMRect(left, top, right - left, bottom - top),
		left: (left - pageSpace.left) / scale,
		top: (top - pageSpace.top) / scale,
		width: (right - left) / scale,
		height: (bottom - top) / scale
	};
}

/** A structural insertion point is selected as one complete gap or gutter control. */
export function structuralBoundaryRect(target: StructuralBoundaryTarget): StructuralBoundaryRect {
	return { x: target.left, y: target.top, width: target.width, height: target.height };
}

export function structuralBoundaryHighlight(
	target: StructuralBoundaryTarget,
	kind: HighlightKind
): HighlightRect {
	return { page: target.page, ...structuralBoundaryRect(target), kind };
}

/** All text on a container's line supplies the same band, including unhighlighted runs. */
export function buildLineMaps(
	stage: HTMLElement,
	pageNumbers?: ReadonlySet<number>
): PageGeometry[] {
	return Array.from(stage.querySelectorAll<HTMLElement>('.document-page'))
		.filter((element) => !pageNumbers || pageNumbers.has(Number(element.dataset.pageNumber)))
		.map((element) => {
			const { bounds, scale } = pageSpace(element);
			const content = element.querySelector('.document-page__content');
			const containers: TextContainer[] = [];
			for (const container of element.querySelectorAll<HTMLElement>(TEXT_CONTAINER_SELECTOR)) {
				const style = getComputedStyle(container);
				const lineHeight = parseFloat(style.lineHeight);
				const collapsedCell =
					container.matches('td, th') &&
					getComputedStyle(container.closest('table')!).borderCollapse === 'collapse';
				const top =
					(container.getBoundingClientRect().top - bounds.top) / scale +
					parseFloat(style.borderTopWidth || '0') / (collapsedCell ? 2 : 1) +
					parseFloat(style.paddingTop || '0');
				const texts: (Omit<TextEntry, 'rects'> & { rects: Omit<TextRect, 'band'>[] })[] = [];
				const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
				for (let node = walker.nextNode(); node; node = walker.nextNode()) {
					// Page-local geometry depends on document content and layout.
					// Outer wrappers govern accessibility and interaction, not text measurements.
					const anchor = node.parentElement?.closest('[data-selection-line-anchor]');
					const hidden = node.parentElement?.closest(
						'[aria-hidden="true"], [data-document-control]'
					);
					if (
						(hidden && content?.contains(hidden) && !anchor) ||
						node.parentElement?.closest(
							'[data-selection-collapsed], [data-generated="empty-hit-target"]:not([data-selection-line-anchor])'
						) ||
						node.parentElement?.closest(TEXT_CONTAINER_SELECTOR) !== container
					)
						continue;
					const rects: Omit<TextRect, 'band'>[] = [];
					const range = document.createRange();
					range.selectNodeContents(node);
					for (const rect of range.getClientRects()) {
						if (!rect.height) continue;
						const y = (rect.top - bounds.top) / scale,
							height = rect.height / scale;
						rects.push({
							y,
							height,
							center: y + height / 2,
							left: (rect.left - bounds.left) / scale,
							right: (rect.right - bounds.left) / scale
						});
					}
					// Hard-break characters can have no ink rectangle in a browser. Their real
					// collapsed carets still supply line bands, including CRLF-only cells.
					for (const match of (node as Text).data.matchAll(/\r\n|[\r\n]/gu)) {
						for (const offset of [match.index, match.index + match[0].length]) {
							range.setStart(node, offset);
							range.collapse(true);
							for (const rect of range.getClientRects()) {
								if (!rect.height) continue;
								const y = (rect.top - bounds.top) / scale,
									height = rect.height / scale;
								rects.push({
									y,
									height,
									center: y + height / 2,
									left: (rect.left - bounds.left) / scale,
									right: (rect.right - bounds.left) / scale
								});
							}
						}
					}
					texts.push({
						node: node as Text,
						length: (node as Text).length,
						rects,
						trigger: node.parentElement?.closest<HTMLElement>('.playbook-trigger') ?? null,
						revision: node.parentElement?.closest<HTMLElement>('[data-revision]')?.dataset.revision,
						selectable: getComputedStyle(node.parentElement!).userSelect !== 'none',
						presentation: Boolean(anchor)
					});
				}
				const bands: Band[] = [];
				const metrics = texts.flatMap((entry) => entry.rects);
				for (const metric of metrics.sort((a, b) => a.center - b.center)) {
					if (Number.isFinite(lineHeight) && lineHeight > 0) {
						const y =
							top +
							Math.max(0, Math.round((metric.center - top - lineHeight / 2) / lineHeight)) *
								lineHeight;
						if (!bands.some((band) => Math.abs(band.y - y) < 0.01))
							bands.push({ y, height: lineHeight, center: y + lineHeight / 2 });
					} else {
						// Zero/normal line height uses the union of text metrics on that line.
						const band = bands.find(
							(band) =>
								Math.abs(band.center - metric.center) < Math.min(band.height, metric.height) / 2
						);
						if (band) {
							const bottom = Math.max(band.y + band.height, metric.y + metric.height);
							band.y = Math.min(band.y, metric.y);
							band.height = bottom - band.y;
							band.center = band.y + band.height / 2;
						} else bands.push({ y: metric.y, height: metric.height, center: metric.center });
					}
				}
				containers.push({
					element: container,
					bands,
					carets: new Map(),
					texts: texts.map((entry) => ({
						...entry,
						rects: entry.rects.map((rect) => ({ ...rect, band: nearestBand(bands, rect.center)! }))
					}))
				});
			}
			const textIndex = containers
				.flatMap((container) => container.texts.map((entry) => ({ entry, container })))
				.sort((a, b) =>
					a.entry.node.compareDocumentPosition(b.entry.node) & Node.DOCUMENT_POSITION_FOLLOWING
						? -1
						: 1
				);
			const textPositions = new WeakMap<Text, number>();
			textIndex.forEach(({ entry }, i) => textPositions.set(entry.node, i));
			return {
				element,
				number: Number(element.dataset.pageNumber),
				containers,
				textIndex,
				textPositions
			};
		});
}

function nearestBand(bands: Band[], center: number): Band | undefined {
	return bands.reduce<Band | undefined>(
		(best, next) =>
			!best || Math.abs(next.center - center) < Math.abs(best.center - center) ? next : best,
		undefined
	);
}

function textInterval(range: Range, node: Text): [number, number] | null {
	if (!node.isConnected || !range.startContainer.isConnected || !range.endContainer.isConnected)
		return null;
	try {
		if (!range.intersectsNode(node)) return null;
		const start =
			range.startContainer === node
				? range.startOffset
				: range.comparePoint(node, 0) >= 0
					? 0
					: node.length;
		const end =
			range.endContainer === node
				? range.endOffset
				: range.comparePoint(node, node.length) <= 0
					? node.length
					: 0;
		return start < end ? [start, end] : null;
	} catch {
		return null;
	}
}

/** Direct text endpoints use the index; element endpoints use ordered boundary searches. */
function rangeTextEntries(page: PageGeometry, range: Range) {
	const { textIndex, textPositions } = page;
	if (!range.startContainer.isConnected || !range.endContainer.isConnected) return [];
	const boundary = (afterEnd: boolean) => {
		let low = 0,
			high = textIndex.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			const entry = textIndex[middle].entry;
			const point = range.comparePoint(entry.node, afterEnd ? 0 : entry.length);
			if (afterEnd ? point <= 0 : point < 0) low = middle + 1;
			else high = middle;
		}
		return low;
	};
	try {
		const start = textPositions.get(range.startContainer as Text) ?? boundary(false);
		const end = textPositions.get(range.endContainer as Text);
		return textIndex.slice(start, end === undefined ? boundary(true) : end + 1);
	} catch {
		return [];
	}
}

export function measureRanges(
	pages: PageGeometry[],
	ranges: readonly Range[],
	kind: HighlightKind
): MeasuredInterval[] {
	const intervals: MeasuredInterval[] = [];
	if (!ranges.length) return intervals;
	const search = kind === 'search-match' || kind === 'search-active';
	let measuredNodes = 0,
		rangeMeasurements = 0;
	const memberships = ranges.map(rangePageInterval);
	const includesPage = (interval: [number, number] | undefined, number: number) =>
		interval !== undefined && number >= interval[0] && number <= interval[1];
	for (const page of pages) {
		if (!memberships.some((interval) => includesPage(interval, page.number))) continue;
		let space: ReturnType<typeof pageSpace> | undefined;
		const measured = new Map<TextContainer, MeasuredInterval[]>();
		for (const [i, input] of ranges.entries()) {
			if (!includesPage(memberships[i], page.number)) continue;
			for (const { entry, container } of rangeTextEntries(page, input)) {
				if (entry.presentation || (kind === 'native-selection' && !entry.selectable)) continue;
				const interval = textInterval(input, entry.node);
				if (!interval) continue;
				if (search) measuredNodes++;
				let contributions = measured.get(container);
				if (!contributions) measured.set(container, (contributions = []));
				if (interval[0] === 0 && interval[1] === entry.length) {
					for (const rect of entry.rects)
						contributions.push({
							page,
							container,
							band: rect.band,
							left: rect.left,
							right: rect.right,
							kind
						});
					continue;
				}
				const { bounds, scale } = (space ??= pageSpace(page.element));
				const range = document.createRange();
				range.setStart(entry.node, interval[0]);
				range.setEnd(entry.node, interval[1]);
				if (search) rangeMeasurements++;
				for (const rect of range.getClientRects()) {
					if (!rect.width || !rect.height) continue;
					const center = (rect.top + rect.height / 2 - bounds.top) / scale;
					const band = nearestBand(container.bands, center);
					if (band)
						contributions.push({
							page,
							container,
							band,
							left: (rect.left - bounds.left) / scale,
							right: (rect.right - bounds.left) / scale,
							kind
						});
				}
			}
		}
		const containers = [...measured.keys()].sort((a, b) =>
			a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
		);
		for (const container of containers) intervals.push(...mergeIntervals(measured.get(container)!));
	}
	if (search) {
		countSearchWork('measuredNodes', measuredNodes);
		countSearchWork('rangeMeasurements', rangeMeasurements);
	}
	return intervals;
}

export function measureRevisions(pages: PageGeometry[]): MeasuredInterval[] {
	return pages.flatMap((page) =>
		page.containers.flatMap((container) => {
			const intervals: MeasuredInterval[] = [];
			for (const entry of container.texts) {
				if (entry.presentation) continue;
				if (entry.revision !== 'added' && entry.revision !== 'removed') continue;
				for (const rect of entry.rects)
					intervals.push({
						page,
						container,
						band: rect.band,
						left: rect.left,
						right: rect.right,
						kind: entry.revision === 'added' ? 'revision-added' : 'revision-removed'
					});
			}
			return mergeIntervals(intervals);
		})
	);
}

export function measureTriggers(pages: PageGeometry[]): MeasuredInterval[] {
	const memberships = new Map<HTMLElement, readonly string[]>();
	const annotationIds = (owner: HTMLElement) => {
		const cached = memberships.get(owner);
		if (cached) return cached;
		const ids: readonly string[] = JSON.parse(owner.dataset.annotationMemberships ?? '[]');
		memberships.set(owner, ids);
		return ids;
	};
	return pages.flatMap((page) =>
		page.containers.flatMap((container) => {
			const intervals: MeasuredInterval[] = [];
			for (const entry of container.texts) {
				if (entry.presentation) continue;
				const owner = entry.trigger;
				if (!owner) continue;
				const ids = annotationIds(owner);
				for (const rect of entry.rects)
					intervals.push({
						page,
						container,
						band: rect.band,
						left: rect.left,
						right: rect.right,
						kind: 'trigger',
						owner,
						annotationIds: ids
					});
			}
			return mergeIntervals(intervals);
		})
	);
}

function mergeIntervals(intervals: MeasuredInterval[]): MeasuredInterval[] {
	const result: MeasuredInterval[] = [];
	// Bands belong to a single container; keep each kind and owner independent.
	const bands = new Map<Band, Map<HighlightKind, Map<HTMLElement | undefined, MeasuredInterval>>>();
	for (const interval of intervals.sort((a, b) => a.band.y - b.band.y || a.left - b.left)) {
		let kinds = bands.get(interval.band);
		if (!kinds) bands.set(interval.band, (kinds = new Map()));
		let owners = kinds.get(interval.kind);
		if (!owners) kinds.set(interval.kind, (owners = new Map()));
		const last = owners.get(interval.owner);
		if (last && interval.left <= last.right + 0.01)
			last.right = Math.max(last.right, interval.right);
		else {
			const merged = { ...interval };
			result.push(merged);
			owners.set(interval.owner, merged);
		}
	}
	return result;
}

/** Subtract within vertically overlapping groups on each page before painting. */
export function resolveOverlaps(
	intervals: MeasuredInterval[],
	hoveredAnnotationId: string | null = null
): HighlightRect[] {
	const pages = new Map<PageGeometry, MeasuredInterval[]>();
	for (const interval of intervals) {
		const page = pages.get(interval.page);
		if (page) page.push(interval);
		else pages.set(interval.page, [interval]);
	}
	return Array.from(pages.values()).flatMap((page) => {
		const groups: MeasuredInterval[][] = [];
		let bottom = -Infinity;
		for (const interval of page.sort((a, b) => a.band.y - b.band.y)) {
			if (interval.band.y >= bottom) {
				groups.push([]);
				bottom = -Infinity;
			}
			groups.at(-1)!.push(interval);
			bottom = Math.max(bottom, interval.band.y + interval.band.height);
		}
		return groups.flatMap((group) => subtractGroup(group, hoveredAnnotationId));
	});
}

function subtractGroup(
	intervals: MeasuredInterval[],
	hoveredAnnotationId: string | null
): HighlightRect[] {
	type Piece = { interval: MeasuredInterval; x: number; y: number; width: number; height: number };
	const result: Piece[] = [];
	for (const interval of intervals.sort(
		(a, b) =>
			HIGHLIGHT_THEME[b.kind].priority - HIGHLIGHT_THEME[a.kind].priority ||
			Number(a.owner?.dataset.annotationPriority ?? 0) -
				Number(b.owner?.dataset.annotationPriority ?? 0) ||
			(a.owner?.dataset.annotationId ?? '').localeCompare(b.owner?.dataset.annotationId ?? '')
	)) {
		let pieces: Piece[] = [
			{
				interval,
				x: interval.left,
				y: interval.band.y,
				width: interval.right - interval.left,
				height: interval.band.height
			}
		];
		for (const cover of result) {
			pieces = pieces.flatMap((piece) => {
				const left = Math.max(piece.x, cover.x),
					right = Math.min(piece.x + piece.width, cover.x + cover.width);
				const top = Math.max(piece.y, cover.y),
					bottom = Math.min(piece.y + piece.height, cover.y + cover.height);
				if (left >= right || top >= bottom) return [piece];
				return [
					{ ...piece, height: top - piece.y },
					{ ...piece, y: bottom, height: piece.y + piece.height - bottom },
					{ ...piece, y: top, height: bottom - top, width: left - piece.x },
					{ ...piece, x: right, y: top, height: bottom - top, width: piece.x + piece.width - right }
				].filter((part) => part.width > 0 && part.height > 0);
			});
			if (!pieces.length) break;
		}
		result.push(...pieces);
	}
	return result.map(({ interval, ...rect }) => {
		const owner = interval.owner;
		return {
			...rect,
			page: interval.page.number,
			kind: interval.kind,
			...(owner
				? {
						triggerState:
							owner.dataset.annotationPending === 'true'
								? ('pending' as const)
								: owner.dataset.annotationSelected === 'true'
									? ('selected' as const)
									: hoveredAnnotationId !== null &&
										  interval.annotationIds?.includes(hoveredAnnotationId)
										? ('hover' as const)
										: ('default' as const)
					}
				: {})
		};
	});
}

export function selectedLineBounds(intervals: MeasuredInterval[]): DOMRect | null {
	// Measurements preserve page and container DOM order, then line order.
	const last = intervals.at(-1);
	if (!last) return null;
	const { bounds, scale } = pageSpace(last.page.element);
	const line = intervals.filter(
		(interval) => interval.container === last.container && interval.band === last.band
	);
	const left = Math.min(...line.map((interval) => interval.left)),
		right = Math.max(...line.map((interval) => interval.right));
	return new DOMRect(
		bounds.left + left * scale,
		bounds.top + last.band.y * scale,
		(right - left) * scale,
		last.band.height * scale
	);
}
