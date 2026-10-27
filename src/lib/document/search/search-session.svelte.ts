import { getDocumentHighlights, type DocumentHighlightController } from '../highlights/controller';
import type { PaginatedPage } from '../pagination/types';
import { DocumentSearchCache, DocumentSearchRanges } from './document-search';
import { getDocumentViewportMetrics } from '../document-viewport';
import { countSearchWork } from '../runtime/render-perf';
import type { DocumentSearchResult } from './types';

const ALL_MATCHES_HIGHLIGHT = 'dinu-search-matches';
const ACTIVE_MATCH_HIGHLIGHT = 'dinu-search-active-match';
const REFRESH_DELAY_MS = 100;

export class DocumentSearchSession {
	query = $state('');
	results = $state.raw<DocumentSearchResult[]>([]);
	activeIndex = $state(-1);
	#controller: DocumentHighlightController | undefined;
	#cache = new DocumentSearchCache();
	#mounted = new DocumentSearchRanges();
	#pages: readonly PaginatedPage[] = [];
	#ranges = new Map<number, Range>();
	#resultsByPage = new Map<number, number[]>();
	#eagerPages: ReadonlySet<number> = new Set();
	#unsubscribePages: (() => void) | undefined;
	#refreshTimer: ReturnType<typeof setTimeout> | undefined;
	#scrollOnRefresh = false;
	#destroyed = false;
	setPages(pages: readonly PaginatedPage[]) {
		if (this.#destroyed) return;
		this.#pages = pages;
	}

	#target: HTMLElement | undefined;
	#panel: HTMLElement | undefined;

	setPanel(panel: HTMLElement | undefined) {
		if (this.#destroyed) return;
		this.#panel = panel;
	}

	get resultCount() {
		return this.results.length;
	}

	get activeResultNumber() {
		return this.activeIndex >= 0 ? this.activeIndex + 1 : 0;
	}

	setTarget(target: HTMLElement | undefined) {
		if (this.#destroyed) return;
		if (this.#target === target && this.#controller === getDocumentHighlights(target)) return;
		this.#cancelRefresh();
		this.#unsubscribePages?.();
		this.#unsubscribePages = undefined;
		this.#clearHighlights();
		this.#mounted.reset();
		this.#ranges.clear();
		this.#resultsByPage.clear();
		this.#eagerPages = new Set();
		this.#target = target;
		this.#controller = getDocumentHighlights(target);
		this.#unsubscribePages = this.#controller?.subscribeEagerPages((pages) => {
			this.#eagerPages = pages;
			if (this.#refreshTimer === undefined && this.#resultsByPage.size)
				this.#materializeHighlights();
		});
	}

	setQuery(query: string) {
		if (this.#destroyed || query === this.query) return;
		this.#cancelRefresh();
		this.#clearHighlights();
		this.#mounted.reset();
		this.#ranges.clear();
		this.query = query;
		this.refresh(true);
	}

	next() {
		if (this.#destroyed) return;
		this.#cancelRefresh();
		if (!this.results.length) return;
		this.activeIndex = (this.activeIndex + 1) % this.results.length;
		this.#refreshHighlights(true);
	}

	previous() {
		if (this.#destroyed) return;
		this.#cancelRefresh();
		if (!this.results.length) return;
		this.activeIndex = (this.activeIndex - 1 + this.results.length) % this.results.length;
		this.#refreshHighlights(true);
	}

	// Text results stay immediate; only DOM work is debounced. Commits never scroll.
	refresh(scrollToFirst = false) {
		if (this.#destroyed) return;
		const activeResult = this.results[this.activeIndex];
		const controller = getDocumentHighlights(this.#target);
		if (controller !== this.#controller) {
			this.setTarget(this.#target);
		}
		this.results = this.#target ? this.#cache.search(this.#pages, this.query) : [];
		this.#resultsByPage.clear();
		for (const [index, result] of this.results.entries()) {
			for (let page = result.start.pageNumber; page <= result.end.pageNumber; page++) {
				let matches = this.#resultsByPage.get(page);
				if (!matches) this.#resultsByPage.set(page, (matches = []));
				matches.push(index);
			}
		}
		const retainedIndex = this.results.indexOf(activeResult);
		if (scrollToFirst) this.activeIndex = 0;
		else if (retainedIndex >= 0) this.activeIndex = retainedIndex;
		this.activeIndex = Math.min(Math.max(this.activeIndex, 0), this.results.length - 1);
		if (!this.results.length) {
			this.#cancelRefresh();
			this.#mounted.reset();
			this.#ranges.clear();
			this.#clearHighlights();
			return;
		}
		this.#scrollOnRefresh ||= scrollToFirst;
		if (this.#refreshTimer !== undefined) clearTimeout(this.#refreshTimer);
		this.#refreshTimer = setTimeout(() => {
			const scroll = this.#scrollOnRefresh;
			this.#cancelRefresh();
			this.#refreshHighlights(scroll);
		}, REFRESH_DELAY_MS);
	}

	#cancelRefresh() {
		if (this.#refreshTimer !== undefined) clearTimeout(this.#refreshTimer);
		this.#refreshTimer = undefined;
		this.#scrollOnRefresh = false;
	}

	#refreshHighlights(scrollToActive: boolean) {
		if (this.#destroyed) return;
		countSearchWork('refreshes');
		this.#materializeHighlights();
		if (scrollToActive && this.results.length) this.#scrollToActiveResult();
	}

	#materializeHighlights() {
		if (!this.#target || this.#destroyed) return;
		const matches = new Set<number>();
		for (const page of this.#eagerPages)
			for (const result of this.#resultsByPage.get(page) ?? []) matches.add(result);
		const active = this.results[this.activeIndex];
		if (active) matches.add(this.activeIndex);
		const selected = [...matches].sort((a, b) => a - b);
		const ranges = this.#mounted.materialize(
			this.#target,
			selected.map((index) => this.results[index]),
			this.#pages
		);
		this.#ranges.clear();
		for (const [index, range] of ranges.entries())
			if (range) this.#ranges.set(selected[index], range);
		// The active group covers its whole match; do not measure it again as an ordinary match.
		this.#controller?.setGroup(
			ALL_MATCHES_HIGHLIGHT,
			'search-match',
			[...this.#ranges].filter(([index]) => index !== this.activeIndex).map(([, range]) => range),
			this.#eagerPages
		);
		const activeRange = this.#ranges.get(this.activeIndex);
		this.#controller?.setGroup(
			ACTIVE_MATCH_HIGHLIGHT,
			'search-active',
			activeRange ? [activeRange] : []
		);
	}

	clear() {
		this.#cancelRefresh();
		this.#cache.reset();
		this.#mounted.reset();
		this.query = '';
		this.results = [];
		this.#ranges.clear();
		this.#resultsByPage.clear();
		this.activeIndex = -1;
		this.#clearHighlights();
	}

	destroy() {
		this.#destroyed = true;
		this.#unsubscribePages?.();
		this.#unsubscribePages = undefined;
		this.#target = undefined;
		this.#eagerPages = new Set();
		this.#pages = [];
		this.#panel = undefined;
		this.clear();
		this.#controller = undefined;
	}

	#clearHighlights() {
		this.#controller?.clearGroup(ALL_MATCHES_HIGHLIGHT);
		this.#controller?.clearGroup(ACTIVE_MATCH_HIGHLIGHT);
	}

	#scrollToActiveResult() {
		if (typeof window === 'undefined') return;
		const activeResult = this.#ranges.get(this.activeIndex);
		if (!activeResult) return;
		this.#controller?.ensureRangeGeometry(activeResult);

		countSearchWork('rangeMeasurements');
		const rects = Array.from(activeResult.getClientRects());
		const rect = rects.find((candidate) => candidate.width > 0 || candidate.height > 0);
		if (!rect) return;

		const searchPanelBottom = this.#panel?.getBoundingClientRect().bottom ?? 0;
		const viewportTop = Math.max(getDocumentViewportMetrics().top, searchPanelBottom + 16);
		const viewportBottom = window.innerHeight - 24;
		if (rect.top >= viewportTop && rect.bottom <= viewportBottom) return;

		const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		window.scrollBy({
			top: rect.top - (viewportTop + viewportBottom) / 2,
			behavior: reducedMotion ? 'auto' : 'smooth'
		});
	}
}
