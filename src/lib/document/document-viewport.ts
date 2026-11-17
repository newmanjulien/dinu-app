const DEFAULT_HEADER_HEIGHT = 41;
const DEFAULT_VIEWPORT_GAP = 16;

function cssPixelValue(styles: CSSStyleDeclaration, property: string, fallback: number) {
	const value = Number.parseFloat(styles.getPropertyValue(property));
	return Number.isFinite(value) ? value : fallback;
}

export function documentViewportFor(element: Element | null | undefined): HTMLElement | null {
	return element?.closest<HTMLElement>('[data-document-viewport]') ?? null;
}

export function getDocumentViewportMetrics(element?: Element | null) {
	if (typeof document === 'undefined') {
		return {
			top: DEFAULT_HEADER_HEIGHT + DEFAULT_VIEWPORT_GAP,
			bottom: 0,
			left: 0,
			right: 0,
			gap: DEFAULT_VIEWPORT_GAP,
			scroller: null
		};
	}

	const scroller = documentViewportFor(element);
	const styles = getComputedStyle(document.documentElement);
	const headerHeight = cssPixelValue(styles, '--app-header-height', DEFAULT_HEADER_HEIGHT);
	const gap = cssPixelValue(styles, '--document-viewport-gap', DEFAULT_VIEWPORT_GAP);
	if (!scroller)
		return {
			top: headerHeight + gap,
			bottom: window.innerHeight,
			left: 0,
			right: window.innerWidth,
			gap,
			scroller
		};
	const bounds = scroller.getBoundingClientRect();
	const top = bounds.top + scroller.clientTop;
	const left = bounds.left + scroller.clientLeft;
	return {
		top: top + gap,
		bottom: top + scroller.clientHeight - gap,
		left,
		right: left + scroller.clientWidth,
		gap,
		scroller
	};
}

type DocumentTargetBounds = Pick<DOMRectReadOnly, 'top' | 'bottom' | 'left' | 'right'>;

type DocumentRevealOptions = {
	bounds?: DocumentTargetBounds;
	block?: 'nearest' | 'start' | 'start-if-hidden' | 'center-if-hidden';
	inline?: 'nearest' | 'none';
	inlineInset?: number;
	topEdge?: number;
	bottomInset?: number;
	behavior?: ScrollBehavior;
};

function nearestOffset(start: number, end: number, viewportStart: number, viewportEnd: number) {
	if (end - start > viewportEnd - viewportStart) {
		if (start > viewportStart) return start - viewportStart;
		if (end < viewportEnd) return end - viewportEnd;
		return 0;
	}
	if (start < viewportStart) return start - viewportStart;
	if (end > viewportEnd) return end - viewportEnd;
	return 0;
}

/** Reveal a target on both axes of its document section, never the surrounding page. */
export function revealInDocumentViewport(
	element: HTMLElement,
	options: DocumentRevealOptions = {}
) {
	const viewport = getDocumentViewportMetrics(element);
	if (!viewport.scroller) return;
	const bounds = options.bounds ?? element.getBoundingClientRect();
	const topEdge = Math.max(viewport.top, options.topEdge ?? viewport.top);
	const bottomEdge = viewport.bottom - (options.bottomInset ?? 0);
	const block = options.block ?? 'nearest';
	const hidden = bounds.top < topEdge || bounds.bottom > bottomEdge;
	const top =
		block === 'start'
			? bounds.top - topEdge
			: block === 'start-if-hidden'
				? bounds.top < topEdge || bounds.top >= bottomEdge
					? bounds.top - topEdge
					: 0
				: block === 'center-if-hidden'
					? hidden
						? bounds.top - (topEdge + bottomEdge) / 2
						: 0
					: nearestOffset(bounds.top, bounds.bottom, topEdge, bottomEdge);
	const inset = options.inlineInset ?? 0;
	const left =
		options.inline === 'none'
			? 0
			: nearestOffset(bounds.left, bounds.right, viewport.left + inset, viewport.right - inset);
	if (top || left)
		viewport.scroller.scrollBy({ top, left, behavior: options.behavior ?? 'instant' });
}
