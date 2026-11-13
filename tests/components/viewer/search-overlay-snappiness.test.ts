import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from '../../support/browser-inputs';
import { DocumentHighlightController } from '../../../src/lib/document/highlights/controller';
import { DocumentGestureInteractions } from '../../../src/lib/document/highlights/interactions';
import { DocumentSearchSession } from '../../../src/lib/document/search/search-session.svelte';
import type { PaginatedPage, ParagraphFragment } from '../../../src/lib/document/pagination/types';
import { fragmentKey } from '../../../src/lib/document/pagination/types';
import type { PreparedBlock } from '../../../src/lib/document/pagination/prepare';
import { documentDom } from '../../support/document-dom';
import { settle } from '../../support/svelte';

let dom: ReturnType<typeof documentDom>;
const cleanups: (() => void)[] = [];
function counters() {
	return window as typeof window & {
		__documentOverlayPerf?: Record<string, number>;
		__documentSearchPerf?: Record<string, number>;
	};
}
beforeEach(() => {
	vi.useFakeTimers();
	Reflect.deleteProperty(window, '__documentOverlayPerf');
	Reflect.deleteProperty(window, '__documentSearchPerf');
	Object.assign(env, { PUBLIC_DOCUMENT_PERF: '1' });
	dom = documentDom();
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	document.getSelection()?.removeAllRanges();
	document.body.innerHTML = '';
	dom.destroy();
	Reflect.deleteProperty(env, 'PUBLIC_DOCUMENT_PERF');
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
		token.dataset.documentToken = '';
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

it('publishes results immediately, reuses text and geometry across scrolling, and rescans only changed pages', async () => {
	const f = fixture();
	await dom.frame();
	expect(counters().__documentOverlayPerf!.measuredPages).toBe(2);
	const search = new DocumentSearchSession();
	cleanups.push(() => search.destroy());
	search.setTarget(f.stage);
	search.setPages(f.pages);
	search.setQuery('needle');
	expect(search.resultCount).toBe(20); // No debounce clock has advanced.
	const scanned = counters().__documentSearchPerf!.scannedCharacters;
	expect(scanned).toBeGreaterThan(0);
	const results = search.results;
	search.refresh();
	expect(search.results).toEqual(results);
	expect(counters().__documentSearchPerf!.scannedCharacters).toBe(scanned);
	await vi.advanceTimersByTimeAsync(100);
	await dom.frame();
	const materialized = counters().__documentSearchPerf!.materializedRanges;
	expect(materialized).toBe(2); // Visible first page and its one neighbor.
	search.next();
	search.previous();
	await dom.frame();
	expect(search.activeResultNumber).toBe(1);
	expect(counters().__documentSearchPerf!.scannedCharacters).toBe(scanned);
	expect(counters().__documentSearchPerf!.materializedRanges).toBe(materialized);
	dom.showPage(10);
	await dom.frame();
	expect(counters().__documentSearchPerf!.scannedCharacters).toBe(scanned);
	expect(counters().__documentSearchPerf!.materializedRanges).toBeLessThanOrEqual(6); // 9–11 plus the active match.
	expect(counters().__documentOverlayPerf!.measuredPages).toBe(5);
	dom.showPage(1);
	f.highlights.projectionChanged();
	await dom.frame();
	expect(counters().__documentOverlayPerf!.measuredPages).toBe(5);
	const first = f.pages[0],
		placement = first.placements[0];
	const changed = {
		...first,
		placements: [
			{
				...placement,
				fragment: {
					...(placement.fragment as ParagraphFragment),
					tokens: [{ value: 'Changed needle text' }]
				}
			}
		]
	};
	search.setPages([changed, ...f.pages.slice(1)]);
	search.refresh();
	expect(search.resultCount).toBe(20);
	expect(counters().__documentSearchPerf!.scannedCharacters - scanned).toBe(
		'changed needle text'.length
	);
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
	const before = counters().__documentOverlayPerf?.hoverChecks ?? 0;
	await dom.frame();
	expect(counters().__documentOverlayPerf!.hoverChecks - before).toBe(1);
	await dom.frame();
	const settled = { ...counters().__documentOverlayPerf };
	for (let i = 0; i < 10; i++) {
		await dom.frame();
		await vi.advanceTimersByTimeAsync(100);
	}
	expect(counters().__documentOverlayPerf).toEqual(settled);
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
	const settled = { ...counters().__documentOverlayPerf };
	for (let i = 0; i < 20; i++) document.dispatchEvent(new Event('selectionchange'));
	await settle();
	expect(dom.frames.size).toBe(0);
	expect(counters().__documentOverlayPerf).toEqual(settled);
});
