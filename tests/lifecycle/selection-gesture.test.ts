import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSourceIndex } from '../../src/lib/contract/source-index';
import { mapDomRange } from '../../src/lib/document/selection/dom-selection';
import { createSelectionInteraction } from '../../src/lib/document/selection/selection-gesture';

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

function pointer(
	target: EventTarget,
	type: 'pointerdown' | 'pointerup',
	pointerId = 1
) {
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
		const interaction = createSelectionInteraction({
			onNativeStart: () => {},
			onNativeComplete: (range) => completed.push(range?.toString() ?? null),
			onCancel: () => {},
			onBoundaryStart: () => null
		});
		interaction.setContainer(root);

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
		const interaction = createSelectionInteraction({
			onNativeStart: () => {},
			onNativeComplete: (range) => completed.push(range?.toString() ?? ''),
			onCancel: () => {},
			onBoundaryStart: () => null
		});
		interaction.setContainer(root);

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
		const interaction = createSelectionInteraction({
			onNativeStart: () => {},
			onNativeComplete: (range) => completed.push(range ? 'complete' : 'empty'),
			onCancel: () => {},
			onBoundaryStart: () => null
		});
		interaction.setContainer(root);

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

		const mapped = mapDomRange(
			range,
			root,
			buildSourceIndex([
				{
					kind: 'paragraph',
					blockKey: 'paragraph-1',
					order: 0,
					content: [{ kind: 'text', sourceKey: 'text-1', text: 'A visible contract clause.' }]
				}
			])
		);

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
		expect(
			mapDomRange(
				range,
				root,
				buildSourceIndex([
					{
						kind: 'paragraph',
						blockKey: 'paragraph-1',
						order: 0,
						content: [{ kind: 'text', sourceKey: 'text-1', text: 'A visible contract clause.' }]
					}
				])
			)
		).toBeNull();
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

		expect(
			mapDomRange(
				range,
				root,
				buildSourceIndex([
					{
						kind: 'paragraph',
						blockKey: 'paragraph-1',
						order: 0,
						content: [{ kind: 'text', sourceKey: 'text-1', text: 'A B' }]
					}
				])
			)?.range
		).toEqual({
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

		expect(
			mapDomRange(
				range,
				root,
				buildSourceIndex([
					{
						kind: 'paragraph',
						blockKey: 'paragraph-1',
						order: 0,
						content: [{ kind: 'text', sourceKey: 'text-1', text: 'AB' }]
					}
				])
			)
		).toBeNull();
	});
});
