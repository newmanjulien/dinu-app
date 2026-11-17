import { afterEach, describe, expect, it } from 'vitest';
import { complete } from '../../../src/lib/document/iteration';
import {
	measureSelectionBreak,
	measureStructuralBoundaryTarget,
	structuralBoundaryRect
} from '../../../src/lib/document/highlights/geometry';
import type { DocumentHighlightController } from '../../../src/lib/document/highlights/controller';
import type { PreparedBlock } from '../../../src/lib/document/pagination/prepare';
import type { InlineToken, PaginatedPage } from '../../../src/lib/document/pagination/types';
import type { RenderSnapshot } from '../../../src/lib/document/runtime/types';
import { buildSourceIndex } from '../../../src/lib/document/source-index';
import type { SourceBlock } from '../../../src/lib/document/source-model';
import {
	DocumentSelectionController,
	SELECTION_GESTURE,
	SOURCE_SELECTION,
	type SelectionNotice
} from '../../../src/lib/document/selection/document-selection';
import { iterateSelectionDocument } from '../../../src/lib/document/selection/selection-model';
import { captureNativeSelection } from '../../../src/lib/document/selection/selection-gesture';
import {
	SelectionSurface,
	mountSelectionPage,
	type DisplayPosition
} from '../../../src/lib/document/selection/selection-surface';

const INTRODUCTION = 'A visible contract clause.';
const RECITALS = 'RECITALS';

function fixture(withEmptyLine = false) {
	const blocks: Extract<SourceBlock, { kind: 'paragraph' }>[] = [
		{
			kind: 'paragraph',
			role: 'body',
			blockKey: 'introduction',
			order: 0,
			content: [{ kind: 'text', sourceKey: 'intro-text', text: INTRODUCTION }]
		},
		...(withEmptyLine
			? [
					{
						kind: 'paragraph' as const,
						role: 'body' as const,
						blockKey: 'empty-line',
						order: 1,
						content: [{ kind: 'text' as const, sourceKey: 'empty-text', text: '' }]
					}
				]
			: []),
		{
			kind: 'paragraph',
			role: 'heading',
			blockKey: 'recitals',
			order: 2,
			content: [{ kind: 'text', sourceKey: 'recitals-text', text: RECITALS }]
		}
	];
	const index = buildSourceIndex(blocks);
	const sourceToken = (sourceKey: string, value: string): InlineToken => ({
		value,
		sourceKind: 'text',
		source: {
			start: { sourceKey, offset: 0 },
			end: { sourceKey, offset: value.length }
		}
	});
	const prepared: PreparedBlock[] = blocks.map((block) => {
		const empty = block.blockKey === 'empty-line';
		const tokens: InlineToken[] = empty
			? [{ value: '\u200b', lineAnchor: true, generated: 'empty-hit-target' }]
			: [
					sourceToken(
						block.blockKey === 'introduction' ? 'intro-text' : 'recitals-text',
						block.blockKey === 'introduction' ? INTRODUCTION : RECITALS
					)
				];
		return {
			flowRole: empty ? 'empty' : block.role === 'heading' ? 'heading' : 'body',
			geometryFingerprint: 'fixture',
			boundariesAfter: [index.structuralBoundaries.get(block.blockKey)!],
			fragment: {
				type: 'paragraph',
				role: block.role,
				blockKey: block.blockKey,
				isFinal: true,
				interval: { start: 0, end: tokens.length },
				gapBefore: block.blockKey === 'recitals' ? 21 : 0,
				tokens
			}
		};
	});
	const page: PaginatedPage = {
		number: 1,
		placements: prepared.map((block) => ({ prepared: block, fragment: block.fragment }))
	};
	const selectionDocument = complete(iterateSelectionDocument(1, index, prepared, [page]));
	const root = document.createElement('div');
	root.tabIndex = -1;
	const pageElement = document.createElement('div');
	pageElement.className = 'document-page';
	pageElement.dataset.pageNumber = '1';
	Object.defineProperty(pageElement, 'offsetWidth', { value: 500 });
	pageElement.getBoundingClientRect = () => new DOMRect(0, 0, 500, 300);
	const content = document.createElement('article');
	content.className = 'document-page__content document-content';
	content.getBoundingClientRect = () => new DOMRect(50, 0, 400, 300);
	pageElement.append(content);
	root.append(pageElement);
	document.body.append(root);
	const breaks = selectionDocument.pages.get(1)?.filter((entry) => entry.kind === 'break') ?? [];
	const appendBreaks = (block: PreparedBlock, edge: 'before' | 'after') => {
		for (const entry of breaks) {
			if (entry.placement.fragment !== block.fragment || entry.edge !== edge) continue;
			const owner = document.createElement('span');
			owner.className = 'selection-break-owner';
			owner.dataset.selectionBreakOwner = String(entry.order);
			owner.dataset.selectionGroup = String(entry.group.id);
			owner.dataset.selectionGap = String(entry.gap);
			owner.getBoundingClientRect = () => new DOMRect(50, 100, 400, 0);
			const controls = document.createElement('span');
			controls.dataset.documentControl = '';
			const target = document.createElement('span');
			target.dataset.structuralBoundary = entry.group.canonical ?? '';
			controls.append(target);
			owner.append(controls);
			content.append(owner);
		}
	};
	for (const block of prepared) {
		const fragment = block.fragment;
		if (fragment.type !== 'paragraph') throw new Error('Expected paragraph');
		appendBreaks(block, 'before');
		const paragraph = document.createElement('p');
		paragraph.className = 'document-block';
		paragraph.dataset.blockKey = fragment.blockKey;
		paragraph.dataset.sourceFragmentKey = `${fragment.blockKey}:0:${fragment.tokens.length}`;
		for (const [tokenIndex, token] of fragment.tokens.entries()) {
			const span = document.createElement('span');
			span.dataset.selectionTokenIndex = String(tokenIndex);
			if (token.source) {
				span.dataset.sourceStartKey = token.source.start.sourceKey;
				span.dataset.sourceEndKey = token.source.end.sourceKey;
				span.dataset.sourceStartOffset = String(token.source.start.offset);
				span.dataset.sourceEndOffset = String(token.source.end.offset);
				span.dataset.sourceKind = token.sourceKind!;
			}
			span.textContent = token.value;
			paragraph.append(span);
		}
		content.append(paragraph);
		appendBreaks(block, 'after');
	}
	mountSelectionPage(pageElement, { page, document: selectionDocument });
	const snapshot: RenderSnapshot = {
		view: 'redline',
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
	const gap = surface.pageBreaks(1)[0];
	const introduction = content.querySelector('[data-source-start-key="intro-text"]')!
		.firstChild as Text;
	const recitals = content.querySelector('[data-source-start-key="recitals-text"]')!
		.firstChild as Text;
	return {
		root,
		pageElement,
		snapshot,
		surface,
		gap: surface.breakPosition(gap),
		gapOwner: gap.element,
		gapTarget: gap.element.querySelector<HTMLElement>('[data-structural-boundary]')!,
		boundaryKey: withEmptyLine ? 'empty-line' : 'introduction',
		introduction,
		recitals,
		selectionDocument
	};
}

function selected(surface: SelectionSurface, anchor: DisplayPosition, head: DisplayPosition) {
	return surface.resolve({ document: surface.document, anchor, head }, true);
}

function nativeSelection(
	surface: SelectionSurface,
	start: { node: Node; offset: number },
	end: { node: Node; offset: number },
	backward = false
) {
	const range = document.createRange();
	range.setStart(start.node, start.offset);
	range.setEnd(end.node, end.offset);
	const anchor = backward ? end : start;
	const focus = backward ? start : end;
	return surface.importNative(captureNativeSelection(range, anchor, focus, {}, surface));
}

function mouse(target: EventTarget, type: 'pointerdown' | 'pointerup', x: number, y: number) {
	const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
	Object.defineProperties(event, {
		button: { value: 0 },
		isPrimary: { value: true },
		pointerId: { value: 1 },
		pointerType: { value: 'mouse' },
		clientX: { value: x },
		clientY: { value: y }
	});
	target.dispatchEvent(event);
}

describe('source selection at the gap before RECITALS', () => {
	const originalElementFromPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
	afterEach(() => {
		document.getSelection()?.removeAllRanges();
		document.body.replaceChildren();
		if (originalElementFromPoint)
			Object.defineProperty(document, 'elementFromPoint', originalElementFromPoint);
		else Reflect.deleteProperty(document, 'elementFromPoint');
	});

	it.each([false, true])(
		'turns a drag within the gap into a boundary selection (empty line: %s)',
		(withEmptyLine) => {
			const { root, pageElement, snapshot, boundaryKey } = fixture(withEmptyLine);
			Object.defineProperty(document, 'elementFromPoint', {
				configurable: true,
				value: () => pageElement
			});
			const painted: string[][] = [];
			const highlights = {
				subscribeGeometry: () => () => {},
				setSelectionProjection: () => {},
				clearStructuralBoundaryGroup: () => {},
				setStructuralBoundaryGroup: (_name: string, _kind: string, selections: { key: string }[]) =>
					painted.push(selections.map((selection) => selection.key)),
				structuralBoundary: () => null,
				selectionHit: () => null
			} as unknown as DocumentHighlightController;
			const notices: SelectionNotice[] = [];
			root.addEventListener(SOURCE_SELECTION, (event) =>
				notices.push((event as CustomEvent<SelectionNotice>).detail)
			);
			const controller = new DocumentSelectionController(root, snapshot, highlights);

			mouse(pageElement, 'pointerdown', 20, 110);
			pageElement.dispatchEvent(
				new MouseEvent('mousedown', {
					bubbles: true,
					cancelable: true,
					button: 0,
					detail: 1,
					clientX: 20,
					clientY: 110
				})
			);
			mouse(window, 'pointerup', 30, 110);

			const completion = notices.findLast((notice) => notice.kind === 'complete');
			expect(completion).toMatchObject({
				kind: 'complete',
				unmappable: false,
				value: { target: { kind: 'boundary', afterBlockKey: boundaryKey } }
			});
			expect(controller.value?.candidate?.target).toEqual({
				kind: 'boundary',
				afterBlockKey: boundaryKey
			});
			expect(painted.at(-1)).toEqual([boundaryKey]);
			controller.destroy();
		}
	);

	it.each([false, true])(
		'keeps a plain click in the gap unselected (empty line: %s)',
		(withEmptyLine) => {
			const { root, pageElement, snapshot } = fixture(withEmptyLine);
			Object.defineProperty(document, 'elementFromPoint', {
				configurable: true,
				value: () => pageElement
			});
			const highlights = {
				subscribeGeometry: () => () => {},
				setSelectionProjection: () => {},
				clearStructuralBoundaryGroup: () => {},
				setStructuralBoundaryGroup: () => {},
				structuralBoundary: () => null,
				selectionHit: () => null
			} as unknown as DocumentHighlightController;
			const gestures: string[] = [];
			const completions: SelectionNotice[] = [];
			root.addEventListener(SELECTION_GESTURE, (event) =>
				gestures.push((event as CustomEvent<{ kind: string }>).detail.kind)
			);
			root.addEventListener(SOURCE_SELECTION, (event) => {
				const notice = (event as CustomEvent<SelectionNotice>).detail;
				if (notice.kind === 'complete') completions.push(notice);
			});
			const controller = new DocumentSelectionController(root, snapshot, highlights);

			mouse(pageElement, 'pointerdown', 20, 110);
			pageElement.dispatchEvent(
				new MouseEvent('mousedown', {
					bubbles: true,
					cancelable: true,
					button: 0,
					detail: 1,
					clientX: 20,
					clientY: 110
				})
			);
			mouse(window, 'pointerup', 20, 110);

			expect(gestures).toContain('click');
			expect(completions).toEqual([]);
			expect(controller.value).toBeNull();
			controller.destroy();
		}
	);

	it('measures one clipped gap for hit testing and paint', () => {
		const { pageElement, surface, gapOwner, gapTarget } = fixture();
		pageElement.getBoundingClientRect = () => new DOMRect(10, 20, 1000, 160);
		const content = gapOwner.closest<HTMLElement>('.document-page__content')!;
		content.getBoundingClientRect = () => new DOMRect(110, 20, 800, 160);
		gapOwner.getBoundingClientRect = () => new DOMRect(110, 150, 800, 0);
		const measured = measureSelectionBreak(gapOwner, 21);
		const painted = measureStructuralBoundaryTarget(gapTarget);

		expect(measured?.bounds).toEqual(new DOMRect(110, 150, 800, 30));
		expect(painted?.bounds).toEqual(measured?.bounds);
		expect(painted && structuralBoundaryRect(painted)).toEqual({
			x: 50,
			y: 65,
			width: 400,
			height: 15
		});
		expect(surface.breakAt(pageElement, 179)?.element).toBe(gapOwner);
		expect(surface.breakAt(pageElement, 180)).toBeNull();
	});

	it.each([false, true])(
		'keeps selections from adjacent text into the gap source-backed (empty line: %s)',
		(withEmptyLine) => {
			const { surface, gap, introduction, recitals } = fixture(withEmptyLine);
			const introEnd = surface.position(introduction, introduction.length)!;
			const introStart = surface.position(introduction, introduction.length - 6)!;
			const recitalsStart = surface.position(recitals, 0)!;
			const recitalsEnd = surface.position(recitals, 4)!;

			expect(selected(surface, introStart, gap)?.target).toEqual({
				kind: 'text',
				range: {
					start: { sourceKey: 'intro-text', offset: introduction.length - 6 },
					end: { sourceKey: 'recitals-text', offset: 0 }
				}
			});
			expect(selected(surface, gap, introStart)?.target).toEqual(
				selected(surface, introStart, gap)?.target
			);
			expect(selected(surface, gap, recitalsEnd)?.target).toEqual({
				kind: 'text',
				range: {
					start: { sourceKey: 'intro-text', offset: introduction.length },
					end: { sourceKey: 'recitals-text', offset: 4 }
				}
			});
			expect(selected(surface, recitalsEnd, gap)?.target).toEqual(
				selected(surface, gap, recitalsEnd)?.target
			);
			expect(selected(surface, introEnd, recitalsStart)?.target).toEqual({
				kind: 'boundary',
				afterBlockKey: withEmptyLine ? 'empty-line' : 'introduction'
			});
		}
	);

	it('keeps nearby text edge drags as text and folds an empty line into the structural gap', () => {
		const { surface, gap, introduction, recitals, selectionDocument } = fixture(true);
		const introStart = surface.position(introduction, introduction.length - 1)!;
		const introEnd = surface.position(introduction, introduction.length)!;
		const recitalsStart = surface.position(recitals, 0)!;
		const recitalsEnd = surface.position(recitals, 1)!;

		expect(selected(surface, introStart, introEnd)?.target).toEqual({
			kind: 'text',
			range: {
				start: { sourceKey: 'intro-text', offset: introduction.length - 1 },
				end: { sourceKey: 'intro-text', offset: introduction.length }
			}
		});
		expect(selected(surface, recitalsStart, recitalsEnd)?.target).toEqual({
			kind: 'text',
			range: {
				start: { sourceKey: 'recitals-text', offset: 0 },
				end: { sourceKey: 'recitals-text', offset: 1 }
			}
		});
		expect(
			selectionDocument.occurrences.some(
				(entry) => entry.kind === 'text' && entry.fragment.startsWith('empty-line:')
			)
		).toBe(false);
		expect(selected(surface, gap, gap)?.candidate?.target).toEqual({
			kind: 'boundary',
			afterBlockKey: 'empty-line'
		});
	});

	it.each([false, true])(
		'imports a native selection across paragraphs in both directions (empty line: %s)',
		(withEmptyLine) => {
			const { surface, introduction, recitals } = fixture(withEmptyLine);
			const start = { node: introduction, offset: introduction.length - 6 };
			const end = { node: recitals, offset: 4 };
			for (const backward of [false, true]) {
				const value = nativeSelection(surface, start, end, backward);
				expect(value?.target).toEqual({
					kind: 'text',
					range: {
						start: { sourceKey: 'intro-text', offset: introduction.length - 6 },
						end: { sourceKey: 'recitals-text', offset: 4 }
					}
				});
				expect(value?.backward).toBe(backward);
			}
		}
	);

	it('imports a native selection ending inside the gap controls', () => {
		const { surface, introduction, gapOwner } = fixture();
		const start = { node: introduction, offset: introduction.length - 6 };
		const end = { node: gapOwner.firstChild!, offset: 0 };
		for (const backward of [false, true]) {
			const value = nativeSelection(surface, start, end, backward);
			expect(value?.target).toEqual({
				kind: 'text',
				range: {
					start: { sourceKey: 'intro-text', offset: introduction.length - 6 },
					end: { sourceKey: 'recitals-text', offset: 0 }
				}
			});
			expect(value?.backward).toBe(backward);
		}
	});

	it('imports the gap alone and does not absorb a range outside its owner', () => {
		const { surface, gapOwner, introduction } = fixture();
		const inside = nativeSelection(
			surface,
			{ node: gapOwner, offset: 0 },
			{ node: gapOwner, offset: 1 }
		);
		expect(inside?.target).toEqual({ kind: 'boundary', afterBlockKey: 'introduction' });
		expect(inside?.breakKeys).toEqual(['introduction']);

		const before = nativeSelection(
			surface,
			{ node: introduction, offset: introduction.length },
			{ node: gapOwner.parentNode!, offset: 1 }
		);
		expect(before?.target).toBeNull();
		expect(before?.extent).toBeNull();
	});

	it('rejects a native range that includes genuinely unowned visible text', () => {
		const { surface, introduction, gapOwner } = fixture();
		const unowned = document.createTextNode('unowned');
		gapOwner.parentNode!.append(unowned);
		const value = nativeSelection(
			surface,
			{ node: introduction, offset: introduction.length - 6 },
			{ node: unowned, offset: unowned.length }
		);
		expect(value?.target).toBeNull();
		expect(value?.extent).toBeNull();
		expect(value?.unavailable).toBe('unowned');
	});

	it('rejects unowned visible text between otherwise valid native endpoints', () => {
		const { surface, introduction, recitals, gapOwner } = fixture();
		gapOwner.parentNode!.insertBefore(document.createTextNode('unowned'), gapOwner);
		const value = nativeSelection(
			surface,
			{ node: introduction, offset: introduction.length - 6 },
			{ node: recitals, offset: 4 }
		);
		expect(value?.target).toBeNull();
		expect(value?.extent).toBeNull();
		expect(value?.unavailable).toBe('unowned');
	});
});
