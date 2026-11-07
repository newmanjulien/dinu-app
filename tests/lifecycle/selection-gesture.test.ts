import {
	SelectionSurface,
	mountSelectionPage
} from '../../src/lib/document/selection/selection-surface';
import { iterateSelectionDocument } from '../../src/lib/document/selection/selection-model';
import { complete } from '../../src/lib/contract/iteration';
import type { PreparedBlock } from '../../src/lib/document/pagination/prepare';
import type { InlineToken } from '../../src/lib/document/pagination/types';
import type { RenderSnapshot } from '../../src/lib/document/runtime/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSourceIndex } from '../../src/lib/contract/source-index';
import { importDomSelection } from '../../src/lib/document/selection/dom-selection';
import {
	captureNativeSelection,
	createSelectionInteraction,
	type CapturedNativeSelection
} from '../../src/lib/document/selection/selection-gesture';

function setupInteraction(
	root: HTMLElement,
	onNativeComplete: (selection: CapturedNativeSelection | null) => void
) {
	const interaction = createSelectionInteraction({
		context: root,
		onNativeStart: () => {},
		onNativeComplete,
		onCancel: () => {}
	});
	interaction.setContainer(root);
	return interaction;
}

function paragraphSourceIndex(text: string) {
	return buildSourceIndex([
		{
			kind: 'paragraph',
			role: 'body',
			blockKey: 'paragraph-1',
			order: 0,
			content: [{ kind: 'text', sourceKey: 'text-1', text }]
		}
	]);
}

/** The same prepared occurrence builder and mounted adapter used by the viewer. */
function mappedRange(
	range: Range,
	root: HTMLElement,
	index: ReturnType<typeof paragraphSourceIndex>
) {
	const start = { node: range.startContainer, offset: range.startOffset },
		end = { node: range.endContainer, offset: range.endOffset };
	const contract = root.querySelector<HTMLElement>('.contract-document')!;
	const block = contract.querySelector<HTMLElement>('.contract-block')!;
	block.dataset.blockKey = 'paragraph-1';
	const tokens = Array.from(
		block.querySelectorAll<HTMLElement>('[data-source-start-key]'),
		(span, tokenIndex): InlineToken => {
			span.dataset.selectionTokenIndex = String(tokenIndex);
			return {
				value: span.textContent!,
				sourceKind: span.dataset.sourceKind as InlineToken['sourceKind'],
				source: {
					start: {
						sourceKey: span.dataset.sourceStartKey!,
						offset: Number(span.dataset.sourceStartOffset)
					},
					end: {
						sourceKey: span.dataset.sourceEndKey!,
						offset: Number(span.dataset.sourceEndOffset)
					}
				}
			};
		}
	);
	const prepared: PreparedBlock = {
		flowRole: 'body',
		geometryFingerprint: 'fixture',
		fragment: {
			type: 'paragraph',
			role: 'body',
			blockKey: 'paragraph-1',
			isFinal: true,
			interval: { start: 0, end: tokens.length },
			tokens
		}
	};
	block.dataset.sourceFragmentKey = `paragraph-1:0:${tokens.length}`;
	const page = { number: 1, placements: [{ prepared, fragment: prepared.fragment }] };
	const selectionDocument = complete(iterateSelectionDocument(1, index, [prepared], [page]));
	const element = document.createElement('div');
	element.className = 'document-page';
	element.dataset.pageNumber = '1';
	contract.before(element);
	element.append(contract);
	mountSelectionPage(element, { page, document: selectionDocument });
	const snapshot: RenderSnapshot = {
		id: 1,
		pages: [page],
		selectionDocument,
		layoutEpoch: 'fixture',
		changedPages: [1],
		source: { revision: 1, blocks: [], items: [], sourceIndex: index },
		concessions: {},
		previewChanges: [],
		addresses: new Map()
	};
	const surface = new SelectionSurface(root, snapshot);
	range.setStart(start.node, start.offset);
	range.setEnd(end.node, end.offset);
	const captured = captureNativeSelection(
		range,
		{ node: range.startContainer, offset: range.startOffset },
		{ node: range.endContainer, offset: range.endOffset },
		{},
		surface
	);
	const value = importDomSelection(captured, surface);
	return value?.target?.kind === 'text' ? value.target : null;
}

function setSelection(node: Text, start = 0, end = node.length) {
	const range = document.createRange();
	range.setStart(node, start);
	range.setEnd(node, end);
	const selection = window.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
}

function clearSelection() {
	window.getSelection()!.removeAllRanges();
}

function pointer(target: EventTarget, type: 'pointerdown' | 'pointerup', pointerId = 1) {
	const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
	Object.defineProperties(event, {
		button: { value: 0 },
		isPrimary: { value: true },
		pointerId: { value: pointerId }
	});
	target.dispatchEvent(event);
}

describe('native selection interaction', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
			window.setTimeout(() => callback(performance.now()), 0)
		);
		vi.stubGlobal('cancelAnimationFrame', (handle: number) => window.clearTimeout(handle));
	});

	afterEach(() => {
		clearSelection();
		document.body.replaceChildren();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('does not promote a selection that disappears before the gesture completes', () => {
		const root = document.createElement('div');
		const text = document.createTextNode('A durable source selection');
		root.append(text);
		document.body.append(root);
		const completed: (string | null)[] = [];
		const interaction = setupInteraction(root, (range) =>
			completed.push(range?.range.toString() ?? null)
		);

		pointer(root, 'pointerdown');
		setSelection(text);
		clearSelection();
		pointer(window, 'pointerup');
		vi.runAllTimers();

		expect(completed).toEqual([null]);
		interaction.destroy();
	});

	it('publishes the final native selection rather than an earlier intermediate selection', () => {
		const root = document.createElement('div');
		const first = document.createTextNode('first');
		const second = document.createTextNode(' second');
		root.append(first, second);
		document.body.append(root);
		const completed: string[] = [];
		const interaction = setupInteraction(root, (range) =>
			completed.push(range?.range.toString() ?? '')
		);

		pointer(root, 'pointerdown');
		setSelection(first);
		const range = document.createRange();
		range.setStart(first, 0);
		range.setEnd(second, second.length);
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
		pointer(window, 'pointerup');
		vi.runAllTimers();

		expect(completed).toEqual(['first second']);
		interaction.destroy();
	});

	it('waits for Shift to be released before publishing keyboard selection', () => {
		const root = document.createElement('div');
		const text = document.createTextNode('keyboard selection');
		root.append(text);
		document.body.append(root);
		const completed: string[] = [];
		const interaction = setupInteraction(root, (range) =>
			completed.push(range ? 'complete' : 'empty')
		);

		root.dispatchEvent(
			new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight', shiftKey: true })
		);
		setSelection(text);
		root.dispatchEvent(
			new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight', shiftKey: true })
		);
		vi.advanceTimersByTime(200);
		expect(completed).toEqual([]);

		root.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }));
		vi.runAllTimers();
		expect(completed).toEqual(['complete']);
		interaction.destroy();
	});

	it('maps a captured range without consulting the live browser selection', () => {
		const root = document.createElement('div');
		root.innerHTML = `<article class="contract-document"><p class="contract-block"><span data-source-start-key="text-1" data-source-end-key="text-1" data-source-start-offset="0" data-source-end-offset="26" data-source-kind="text">A visible contract clause.</span></p></article>`;
		document.body.append(root);
		const text = root.querySelector('span')!.firstChild as Text;
		const range = document.createRange();
		range.setStart(text, 0);
		range.setEnd(text, text.length);
		clearSelection();

		const mapped = mappedRange(range, root, paragraphSourceIndex('A visible contract clause.'));

		expect(mapped?.range).toEqual({
			start: { sourceKey: 'text-1', offset: 0 },
			end: { sourceKey: 'text-1', offset: 26 }
		});
	});

	it('rejects unowned formatting whitespace at a structural boundary', () => {
		const root = document.createElement('div');
		root.innerHTML = `<article class="contract-document"><p class="contract-block"><span data-source-start-key="text-1" data-source-end-key="text-1" data-source-start-offset="0" data-source-end-offset="26" data-source-kind="text">A visible contract clause.</span> <span class="structural-boundary-target" data-structural-boundary="paragraph-1" aria-hidden="true"></span></p></article>`;
		document.body.append(root);
		const text = root.querySelector('[data-source-start-key="text-1"]')!.firstChild as Text;
		const boundary = root.querySelector('.structural-boundary-target')!;
		const range = document.createRange();
		range.setStart(text, 0);
		range.setEnd(boundary, 0);

		expect(range.toString()).toBe('A visible contract clause. ');
		expect(mappedRange(range, root, paragraphSourceIndex('A visible contract clause.'))).toBeNull();
	});

	it('maps source-backed whitespace with its source offsets', () => {
		const root = document.createElement('div');
		root.innerHTML = `<article class="contract-document"><p class="contract-block"><span data-source-start-key="text-1" data-source-end-key="text-1" data-source-start-offset="0" data-source-end-offset="1" data-source-kind="text">A</span><span data-source-start-key="text-1" data-source-end-key="text-1" data-source-start-offset="1" data-source-end-offset="2" data-source-kind="text"> </span><span data-source-start-key="text-1" data-source-end-key="text-1" data-source-start-offset="2" data-source-end-offset="3" data-source-kind="text">B</span></p></article>`;
		document.body.append(root);
		const tokens = root.querySelectorAll('[data-source-start-key="text-1"]');
		const first = tokens[0].firstChild as Text;
		const last = tokens[2].firstChild as Text;
		const range = document.createRange();
		range.setStart(first, 0);
		range.setEnd(last, last.length);

		expect(mappedRange(range, root, paragraphSourceIndex('A B'))?.range).toEqual({
			start: { sourceKey: 'text-1', offset: 0 },
			end: { sourceKey: 'text-1', offset: 3 }
		});
	});

	it('rejects visible contract text without source ownership', () => {
		const root = document.createElement('div');
		root.innerHTML = `<article class="contract-document"><p class="contract-block"><span data-source-start-key="text-1" data-source-end-key="text-1" data-source-start-offset="0" data-source-end-offset="1" data-source-kind="text">A</span><em>unexpected</em><span data-source-start-key="text-1" data-source-end-key="text-1" data-source-start-offset="1" data-source-end-offset="2" data-source-kind="text">B</span></p></article>`;
		document.body.append(root);
		const tokens = root.querySelectorAll('[data-source-start-key="text-1"]');
		const first = tokens[0].firstChild as Text;
		const last = tokens[1].firstChild as Text;
		const range = document.createRange();
		range.setStart(first, 0);
		range.setEnd(last, last.length);

		expect(mappedRange(range, root, paragraphSourceIndex('AB'))).toBeNull();
	});
});
