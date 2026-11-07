import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from '../perf/browser-inputs';
import { DocumentHighlightController } from '../../src/lib/document/highlights/controller';
import { DocumentGestureInteractions } from '../../src/lib/document/highlights/interactions';
import { DocumentSearchSession } from '../../src/lib/document/search/search-session.svelte';
import { DocumentSearchCache } from '../../src/lib/document/search/document-search';
import type { PaginatedPage, ParagraphFragment } from '../../src/lib/document/pagination/types';
import { fragmentKey } from '../../src/lib/document/pagination/types';
import type { PreparedBlock } from '../../src/lib/document/pagination/prepare';
import { documentDom } from './snappiness-dom';
import { settle } from './snappiness-fixtures';

let dom: ReturnType<typeof documentDom>;
const cleanups: (() => void)[] = [];
function counters() {
	return window as typeof window & {
		__contractOverlayPerf?: Record<string, number>;
		__contractSearchPerf?: Record<string, number>;
	};
}
beforeEach(() => {
	vi.useFakeTimers();
	Reflect.deleteProperty(window, '__contractOverlayPerf');
	Reflect.deleteProperty(window, '__contractSearchPerf');
	Object.assign(env, { PUBLIC_CONTRACT_PERF: '1' });
	dom = documentDom();
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	document.getSelection()?.removeAllRanges();
	document.body.innerHTML = '';
	dom.destroy();
	Reflect.deleteProperty(env, 'PUBLIC_CONTRACT_PERF');
	vi.useRealTimers();
});
function fixture(count = 20) {
	const stage = document.createElement('div');
	stage.className = 'document-stage';
	const pages: PaginatedPage[] = [];
	for (let i = 1; i <= count; i++) {
		const fragment: ParagraphFragment = {
			type: 'paragraph',
			role: 'body',
			blockKey: `paragraph-${i}`,
			tokens: [{ value: `Needle on page ${i}` }],
			isFinal: true
		};
		pages.push({ number: i, placements: [{ fragment, prepared: {} as PreparedBlock }] });
		const page = document.createElement('div');
		page.className = 'document-page';
		page.dataset.pageNumber = String(i);
		Object.defineProperty(page, 'offsetWidth', { value: 600 });
		const content = document.createElement('div');
		content.className = 'document-page__content';
		const paragraph = document.createElement('p');
		paragraph.dataset.sourceFragmentKey = fragmentKey(fragment);
		paragraph.style.lineHeight = '20px';
		const token = document.createElement('span');
		token.dataset.contractToken = '';
		token.textContent = fragment.tokens[0].value;
		paragraph.append(token);
		content.append(paragraph);
		page.append(content);
		stage.append(page);
	}
	document.body.append(stage);
	const highlights = new DocumentHighlightController(stage);
	cleanups.push(() => highlights.destroy());
	highlights.contentCommitted(
		'epoch',
		pages.map((p) => p.number)
	);
	return { stage, pages, highlights };
}

it('reuses cached text matches for unchanged pages and only rescans changed page text', () => {
	const f = fixture(),
		cache = new DocumentSearchCache();
	const results = cache.search(f.pages, 'needle');
	expect(results).toHaveLength(20);
	const scanned = counters().__contractSearchPerf!.scannedCharacters;
	expect(scanned).toBeGreaterThan(0);
	expect(cache.search(f.pages, 'needle')).toEqual(results);
	expect(counters().__contractSearchPerf!.scannedCharacters).toBe(scanned);
	const first = f.pages[0],
		placement = first.placements[0],
		fragment = placement.fragment as ParagraphFragment;
	const changed = {
		...first,
		placements: [
			{ ...placement, fragment: { ...fragment, tokens: [{ value: 'Changed needle text' }] } }
		]
	};
	cache.search([changed, ...f.pages.slice(1)], 'needle');
	expect(counters().__contractSearchPerf!.scannedCharacters - scanned).toBe(
		'changed needle text'.length
	);
});

it('publishes search results immediately and next/previous reuse matches and viewport-limited DOM ranges', async () => {
	const f = fixture();
	await dom.frame();
	const search = new DocumentSearchSession();
	cleanups.push(() => search.destroy());
	search.setTarget(f.stage);
	search.setPages(f.pages);
	search.setQuery('needle');
	expect(search.resultCount).toBe(20); // No debounce clock has advanced.
	const scanned = counters().__contractSearchPerf!.scannedCharacters;
	await vi.advanceTimersByTimeAsync(100);
	await dom.frame();
	const materialized = counters().__contractSearchPerf!.materializedRanges;
	expect(materialized).toBe(2); // Visible first page and its one neighbor.
	search.next();
	search.previous();
	await dom.frame();
	expect(search.activeResultNumber).toBe(1);
	expect(counters().__contractSearchPerf!.scannedCharacters).toBe(scanned);
	expect(counters().__contractSearchPerf!.materializedRanges).toBe(materialized);
	dom.showPage(10);
	await dom.frame();
	expect(counters().__contractSearchPerf!.scannedCharacters).toBe(scanned);
	expect(counters().__contractSearchPerf!.materializedRanges).toBeLessThanOrEqual(6); // 9–11 plus the active match.
});

it('measures only the viewport and neighbors, and scrolling reuses already measured text geometry', async () => {
	const f = fixture();
	await dom.frame();
	expect(counters().__contractOverlayPerf!.measuredPages).toBe(2);
	dom.showPage(10);
	await dom.frame();
	expect(counters().__contractOverlayPerf!.measuredPages).toBe(5);
	dom.showPage(1);
	f.highlights.projectionChanged();
	await dom.frame();
	expect(counters().__contractOverlayPerf!.measuredPages).toBe(5);
});

it('coalesces pointer moves into one hover check per frame and performs no ongoing work while idle', async () => {
	const f = fixture(),
		interactions = new DocumentGestureInteractions(f.stage, f.highlights, vi.fn());
	cleanups.push(() => interactions.destroy());
	interactions.setPolicy({ clauseActivation: true, backgroundActivation: true });
	await dom.frame();
	for (let i = 0; i < 40; i++) {
		const event = new MouseEvent('pointermove', { bubbles: true, clientX: 30, clientY: 90 });
		Object.defineProperty(event, 'pointerType', { value: 'mouse' });
		Object.defineProperty(event, 'pointerId', { value: 1 });
		Object.defineProperty(event, 'isPrimary', { value: true });
		f.stage.dispatchEvent(event);
	}
	const before = counters().__contractOverlayPerf?.hoverChecks ?? 0;
	await dom.frame();
	expect(counters().__contractOverlayPerf!.hoverChecks - before).toBe(1);
	await dom.frame();
	const settled = { ...counters().__contractOverlayPerf };
	for (let i = 0; i < 10; i++) {
		await dom.frame();
		await vi.advanceTimersByTimeAsync(100);
	}
	expect(counters().__contractOverlayPerf).toEqual(settled);
	expect(dom.frames.size).toBe(0);
});

it('repeated unchanged selection notifications reuse geometry and schedule no further frames', async () => {
	const f = fixture();
	await dom.frame();
	const text = f.stage.querySelector('p span')!.firstChild!,
		range = document.createRange();
	range.setStart(text, 0);
	range.setEnd(text, 6);
	document.getSelection()!.removeAllRanges();
	document.getSelection()!.addRange(range);
	document.dispatchEvent(new Event('selectionchange'));
	await dom.frame();
	await dom.frame();
	const settled = { ...counters().__contractOverlayPerf };
	for (let i = 0; i < 20; i++) document.dispatchEvent(new Event('selectionchange'));
	await settle();
	expect(dom.frames.size).toBe(0);
	expect(counters().__contractOverlayPerf).toEqual(settled);
});
