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
	triggerState?: 'default' | 'hover' | 'selected';
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
	minimumSelectionWidth: number;
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
}
export interface PageGeometry {
	element: HTMLElement;
	number: number;
	containers: TextContainer[];
	/** DOM order, including nested text containers and table cells. */
	textIndex: { entry: TextEntry; container: TextContainer }[];
	textPositions: WeakMap<Text, number>;
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
export function measureStructuralBoundaryTarget(target: HTMLElement): StructuralBoundaryTarget | null {
	const key = target.dataset.structuralBoundary;
	const page = target.closest<HTMLElement>('.document-page');
	const content = target.closest<HTMLElement>('.document-page__content');
	if (!key || !page || !content || !target.isConnected)
		return null;
	const pageSpace = page.getBoundingClientRect();
	const contentBounds = content.getBoundingClientRect();
	const targetBounds = target.getBoundingClientRect();
	const scale = pageSpace.width / page.offsetWidth;
	if (!Number.isFinite(scale) || scale <= 0) return null;
	const top = Math.max(targetBounds.top, contentBounds.top, pageSpace.top);
	const bottom = Math.min(targetBounds.bottom, contentBounds.bottom, pageSpace.bottom);
	const left = Math.max(targetBounds.left, contentBounds.left, pageSpace.left);
	const right = Math.min(targetBounds.right, contentBounds.right, pageSpace.right);
	if (bottom - top < 1 || right - left < 1) return null;
	const fontSize = parseFloat(getComputedStyle(target).fontSize);
	return {
		key,
		page: Number(page.dataset.pageNumber),
		bounds: new DOMRect(left, top, right - left, bottom - top),
		left: (left - pageSpace.left) / scale,
		top: (top - pageSpace.top) / scale,
		width: (right - left) / scale,
		height: (bottom - top) / scale,
		// In this document font, one em is the visual width of two ordinary spaces.
		minimumSelectionWidth: Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 15
	};
}

/** Project a dragged position in a structural gap onto a compact, two-space selection rectangle. */
export function structuralBoundaryRect(
	target: StructuralBoundaryTarget,
	startRatio: number,
	endRatio: number
): StructuralBoundaryRect {
	const clamp = (value: number) => Math.max(0, Math.min(1, value));
	const start = target.left + clamp(startRatio) * target.width;
	const end = target.left + clamp(endRatio) * target.width;
	const minimum = Math.min(target.minimumSelectionWidth, target.width);
	const width = Math.max(minimum, Math.abs(end - start));
	const preferredLeft = end >= start ? start : start - width;
	const left = Math.max(target.left, Math.min(preferredLeft, target.left + target.width - width));
	return { x: left, y: target.top, width, height: target.height };
}

export function structuralBoundaryHighlight(
	target: StructuralBoundaryTarget,
	startRatio: number,
	endRatio: number,
	kind: HighlightKind
): HighlightRect {
	return {
		page: target.page,
		...structuralBoundaryRect(target, startRatio, endRatio),
		kind
	};
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
					if (
						node.parentElement?.closest('[aria-hidden="true"]') ||
						node.parentElement?.closest(TEXT_CONTAINER_SELECTOR) !== container
					)
						continue;
					const rects: Omit<TextRect, 'band'>[] = [];
					const range = document.createRange();
					range.selectNodeContents(node);
					for (const rect of range.getClientRects()) {
						if (!rect.width || !rect.height) continue;
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
					texts.push({
						node: node as Text,
						length: (node as Text).length,
						rects,
						trigger: node.parentElement?.closest<HTMLElement>('.playbook-trigger') ?? null,
						revision: node.parentElement?.closest<HTMLElement>('[data-revision]')?.dataset.revision,
						selectable: getComputedStyle(node.parentElement!).userSelect !== 'none'
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
				if (kind === 'native-selection' && !entry.selectable) continue;
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
		(a, b) => HIGHLIGHT_THEME[b.kind].priority - HIGHLIGHT_THEME[a.kind].priority
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
							owner.dataset.annotationSelected === 'true'
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
