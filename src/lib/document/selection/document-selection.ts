import type { RenderSnapshot } from '../runtime/types';
import type { DocumentHighlightController } from '../highlights/controller';
import { getDocumentViewportMetrics } from '../document-viewport';
import { importDomSelection } from './dom-selection';
import {
	createSelectionInteraction,
	isDocumentControl,
	type CapturedNativeSelection
} from './selection-gesture';
import {
	SelectionSurface,
	type DisplayExtent,
	type DisplayPosition,
	type SelectionValue
} from './selection-surface';
import type { SelectionCandidate } from './selection-model';
import { sameSourceTarget } from '$lib/contract/source-model';

export const SOURCE_SELECTION = 'document-source-selection';
export const SELECTION_GESTURE = 'document-selection-gesture';
export type SelectionNotice =
	| { kind: 'start' }
	| { kind: 'cancel' }
	| { kind: 'complete'; value: SelectionValue | null; unmappable: boolean };
export type GestureNotice = {
	kind: 'start' | 'click' | 'selection' | 'cancel';
	x: number;
	y: number;
};
const controllers = new WeakMap<HTMLElement, DocumentSelectionController>();
export const getDocumentSelection = (root: HTMLElement | undefined) =>
	root ? controllers.get(root) : undefined;
const GROUP = 'document-selection-breaks';

/** One source-picking owner per active, committed document snapshot. */
export class DocumentSelectionController {
	readonly surface: SelectionSurface;
	#events = new AbortController();
	#interaction: ReturnType<typeof createSelectionInteraction>;
	#unsubscribe: () => void;
	#value: SelectionValue | null = null;
	#anchor: DisplayPosition | null = null;
	#drag: {
		anchor: DisplayPosition | null;
		startX: number;
		startY: number;
		x: number;
		y: number;
		dragged: boolean;
		shift: boolean;
	} | null = null;
	#frame: number | undefined;
	#destroyed = false;
	#scrollOwner: HTMLElement | Window;
	#lastFrame = 0;
	#toolbar: HTMLElement | undefined;

	constructor(
		readonly root: HTMLElement,
		readonly snapshot: RenderSnapshot,
		readonly highlights: DocumentHighlightController
	) {
		this.surface = new SelectionSurface(root, snapshot);
		this.#scrollOwner = this.#findScrollOwner();
		controllers.set(root, this);
		root.setAttribute('data-source-selection-enabled', '');
		this.#interaction = createSelectionInteraction({
			context: this.surface,
			onMouseStart: (event) => this.#mouse(event),
			onNativeStart: (event) => {
				if (event && this.#value && event.key.toLowerCase() !== 'a')
					this.surface.bridge(this.#value);
				this.#stopFrame();
				this.#drag = null;
				this.#value = null;
				this.#anchor = null;
				this.root.removeAttribute('data-selection-drag');
				this.highlights.setSelectionProjection(null);
				this.highlights.clearStructuralBoundaryGroup(GROUP);
				this.#notice({ kind: 'start' });
			},
			onNativeComplete: (range) => this.#nativeComplete(range),
			onCancel: () => this.clear(),
			onNavigation: (event) => {
				if (event.key !== 'Escape' && this.#value) this.surface.bridge(this.#value);
				this.clear(event.key === 'Escape');
			}
		});
		this.#interaction.setContainer(root);
		const options = { signal: this.#events.signal };
		document.addEventListener('copy', this.#copy, options);
		document.addEventListener('selectionchange', this.#selectionChanged, options);
		document.addEventListener('scroll', this.#geometryChanged, {
			...options,
			capture: true,
			passive: true
		});
		window.addEventListener('resize', this.#geometryChanged, options);
		window.addEventListener('blur', this.#blur, options);
		document.addEventListener('pointerdown', this.#external, { ...options, capture: true });
		document.addEventListener('focusin', this.#external, { ...options, capture: true });
		this.#unsubscribe = highlights.subscribeGeometry(this.#geometryChanged);
	}
	get selecting() {
		return this.#interaction.selecting;
	}
	get value() {
		return this.#value;
	}
	#notice(detail: SelectionNotice) {
		this.root.dispatchEvent(new CustomEvent(SOURCE_SELECTION, { detail }));
	}
	#gesture(kind: GestureNotice['kind'], x = 0, y = 0) {
		this.root.dispatchEvent(
			new CustomEvent<GestureNotice>(SELECTION_GESTURE, { detail: { kind, x, y } })
		);
	}
	#findScrollOwner(): HTMLElement | Window {
		for (let node = this.root.parentElement; node; node = node.parentElement) {
			if (
				/(auto|scroll)/.test(getComputedStyle(node).overflowY) &&
				node.scrollHeight > node.clientHeight
			)
				return node;
		}
		return window;
	}
	bindToolbar(element: HTMLElement) {
		this.#toolbar = element;
		return () => {
			if (this.#toolbar === element) this.#toolbar = undefined;
		};
	}
	#ownedToolbar(target: EventTarget | null) {
		return (
			target instanceof Node &&
			Boolean(this.#toolbar?.contains(target)) &&
			this.#toolbar?.ownerDocument === this.root.ownerDocument
		);
	}
	#external = (event: Event) => {
		if (
			event.target instanceof Node &&
			(!this.root.contains(event.target) || isDocumentControl(event.target)) &&
			!this.#ownedToolbar(event.target)
		) {
			this.#interaction.cancel();
			this.clear();
		}
	};
	#blur = () => {
		this.#interaction.cancel();
		this.clear(true);
	};
	#selectionChanged = () => {
		if (!this.#value || this.#interaction.selecting) return;
		const selection = this.root.ownerDocument.getSelection(),
			expected = this.#value.range;
		const structural =
			this.#value.extent &&
			this.#value.extent.anchor.occurrence === this.#value.extent.head.occurrence &&
			this.surface.entry(this.#value.extent.anchor).kind === 'break';
		if (structural && (!selection || selection.isCollapsed)) return;
		const actual = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
		if (
			!expected ||
			!actual ||
			expected.startContainer !== actual.startContainer ||
			expected.startOffset !== actual.startOffset ||
			expected.endContainer !== actual.endContainer ||
			expected.endOffset !== actual.endOffset
		)
			this.clear();
	};
	#geometryChanged = () => {
		if (this.#drag) this.#schedule();
		else if (this.#value?.extent && !this.surface.live(this.#value.extent.head)) this.clear(true);
	};
	#hit(x: number, y: number, captured = false): DisplayPosition | null {
		const element = this.root.ownerDocument.elementFromPoint(x, y);
		// Captured drags may leave a page into its ancestor's blank canvas, but cannot
		// snap through a sibling panel, another document or a portaled overlay.
		if (element && !this.root.contains(element) && (!captured || !element.contains(this.root)))
			return null;
		if (
			element &&
			(isDocumentControl(element) || element.closest('[data-document-chrome], [inert]'))
		)
			return null;
		let page = element?.closest<HTMLElement>('.document-page');
		if (!page && captured) {
			let distance = Infinity;
			for (const candidate of this.root.querySelectorAll<HTMLElement>('.document-page')) {
				const bounds = candidate.getBoundingClientRect();
				const next = Math.hypot(
					Math.max(bounds.left - x, 0, x - bounds.right),
					Math.max(bounds.top - y, 0, y - bounds.bottom)
				);
				if (next < distance) {
					page = candidate;
					distance = next;
				}
			}
		}
		if (!page || !this.root.contains(page)) return null;
		// Gap rectangles are the real existing margins. Zero-area gutters are saved navigation only.
		for (const group of this.surface.pageBreaks(Number(page.dataset.pageNumber))) {
			if (group.page !== Number(page.dataset.pageNumber) || group.occurrence.gap <= 0) continue;
			const bounds = this.highlights.structuralBoundary(group.key)?.bounds;
			if (bounds && y >= bounds.top && y < bounds.bottom) return this.surface.breakPosition(group);
		}
		const bounds = page.getBoundingClientRect();
		const hit = this.highlights.selectionHit(
			page,
			Math.max(bounds.left, Math.min(bounds.right, x)),
			Math.max(bounds.top, Math.min(bounds.bottom, y))
		);
		return hit ? this.surface.position(hit.node, hit.offset, hit.affinity) : null;
	}
	#mouse(event: PointerEvent) {
		const page = event.target instanceof Element ? event.target.closest('.document-page') : null;
		if (!page || !this.root.contains(page)) return null;
		const origin = this.#hit(event.clientX, event.clientY);
		return {
			start: (mouse: MouseEvent) => {
				const retained = this.#anchor && this.surface.live(this.#anchor) ? this.#anchor : null;
				this.#notice({ kind: 'start' });
				this.clear(false, false);
				this.root.focus({ preventScroll: true });
				this.root.ownerDocument.getSelection()?.removeAllRanges();
				this.highlights.setSelectionProjection([]);
				this.root.setAttribute('data-selection-drag', '');
				this.#gesture('start', event.clientX, event.clientY);
				this.#anchor = mouse.shiftKey && retained ? retained : origin;
				this.#drag = {
					anchor: this.#anchor,
					startX: event.clientX,
					startY: event.clientY,
					x: event.clientX,
					y: event.clientY,
					dragged: Boolean(mouse.shiftKey && retained),
					shift: mouse.shiftKey
				};
				if (mouse.shiftKey && retained) this.#update(true);
			},
			move: (move: PointerEvent) => {
				if (!this.#drag) return;
				this.#drag.x = move.clientX;
				this.#drag.y = move.clientY;
				this.#schedule();
			},
			finish: (up: PointerEvent | undefined, cancelled: boolean) => {
				const drag = this.#drag;
				if (!drag) return;
				this.#stopFrame();
				if (cancelled || !up || !this.root.isConnected) {
					this.#gesture('cancel');
					this.clear(true);
					return;
				}
				drag.x = up.clientX;
				drag.y = up.clientY;
				this.#update(true);
				this.#drag = null;
				this.root.removeAttribute('data-selection-drag');
				if (!drag.dragged) {
					this.#value = null;
					this.highlights.setSelectionProjection(null);
					this.#gesture(drag.shift ? 'cancel' : 'click', up.clientX, up.clientY);
					return;
				}
				this.#gesture('selection', up.clientX, up.clientY);
				this.#notice({
					kind: 'complete',
					value: this.#value,
					unmappable: Boolean(this.#value && !this.#value.target)
				});
			}
		};
	}
	#update(final = false) {
		const drag = this.#drag;
		if (!drag) return false;
		if (!drag.dragged && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 5)
			drag.dragged = true;
		if (!drag.dragged) return false;
		const head = this.#hit(drag.x, drag.y, true);
		// Never retain an earlier authorable target when the actual release cannot be resolved.
		if (!head || !drag.anchor) {
			this.#value = null;
			this.highlights.setSelectionProjection([]);
			this.highlights.clearStructuralBoundaryGroup(GROUP);
			this.root.ownerDocument.getSelection()?.removeAllRanges();
			return false;
		}
		const extent: DisplayExtent = { document: this.surface.document, anchor: drag.anchor, head };
		this.#value = this.surface.resolve(extent, final);
		if (this.#value) {
			this.surface.project(this.#value);
			this.highlights.setSelectionProjection(this.#value.range ? [this.#value.range] : []);
			this.#paintBreaks();
		} else {
			this.root.ownerDocument.getSelection()?.removeAllRanges();
			this.highlights.setSelectionProjection([]);
			this.highlights.clearStructuralBoundaryGroup(GROUP);
		}
		return true;
	}
	#paintBreaks() {
		this.highlights.setStructuralBoundaryGroup(
			GROUP,
			'authoring-selection',
			(this.#value?.breakKeys ?? []).map((key) => ({ key }))
		);
	}

	#schedule() {
		if (!this.#drag || this.#frame !== undefined) return;
		this.#frame = requestAnimationFrame((time) => {
			this.#frame = undefined;
			if (!this.#drag || this.#destroyed) return;
			const { x, y } = this.#drag;
			const bounds =
				this.#scrollOwner instanceof HTMLElement
					? this.#scrollOwner.getBoundingClientRect()
					: {
							top: getDocumentViewportMetrics().top,
							bottom: window.innerHeight,
							left: 0,
							right: window.innerWidth
						};
			const distance =
				y < bounds.top + 48
					? y - bounds.top - 48
					: y > bounds.bottom - 48
						? y - bounds.bottom + 48
						: 0;
			const delta =
				Math.max(-24, Math.min(24, distance / 4)) *
				Math.min(2, this.#lastFrame ? (time - this.#lastFrame) / 16.67 : 1);
			this.#lastFrame = time;
			const resolved = this.#update();
			if (delta && resolved && x >= bounds.left && x <= bounds.right) {
				const previous =
					this.#scrollOwner instanceof HTMLElement ? this.#scrollOwner.scrollTop : window.scrollY;
				this.#scrollOwner.scrollBy({ top: delta, behavior: 'instant' });
				const current =
					this.#scrollOwner instanceof HTMLElement ? this.#scrollOwner.scrollTop : window.scrollY;
				if (current !== previous) this.#schedule();
			}
		});
	}
	#stopFrame() {
		if (this.#frame !== undefined) cancelAnimationFrame(this.#frame);
		this.#frame = undefined;
		this.#lastFrame = 0;
	}
	#nativeComplete(captured: CapturedNativeSelection | null) {
		const value = captured ? importDomSelection(captured, this.surface) : null;
		this.#value = value;
		this.#anchor = value?.extent?.anchor ?? null;
		if (value?.target) {
			this.surface.project(value);
		}
		this.#paintBreaks();
		this.#notice({ kind: 'complete', value, unmappable: Boolean(value && !value.target) });
	}
	#copy = (event: ClipboardEvent) => {
		if (
			!this.#value ||
			!event.clipboardData ||
			this.#destroyed ||
			!this.root.isConnected ||
			!this.root.contains(document.activeElement)
		)
			return;
		if (isDocumentControl(event.target) || isDocumentControl(document.activeElement)) return;
		const serialized = this.surface.serialize(this.#value);
		if (serialized === null) return;
		event.clipboardData.setData('text/plain', serialized.text);
		event.clipboardData.setData('text/html', serialized.html);
		event.preventDefault();
	};
	bounds() {
		if (!this.#value) return null;
		return (
			(this.#value.range ? this.highlights.rangeBounds([this.#value.range]) : null) ??
			(this.#value.breakKeys[0]
				? this.highlights.structuralBoundarySelectionBounds(this.#value.breakKeys[0])
				: null)
		);
	}
	resolveCandidate(token: object): SelectionCandidate | null {
		const value = this.#value;
		if (!value?.candidate || value.candidate.token !== token || !value.extent) return null;
		const current = this.surface.resolve(value.extent, true, value.nativeInput);
		return current?.candidate && sameSourceTarget(current.candidate.target, value.candidate.target)
			? { ...current.candidate, token }
			: null;
	}
	clear(clearDom = false, notify = true) {
		const changed = Boolean(
			this.#value || this.#drag || this.root.hasAttribute('data-selection-drag')
		);
		this.#stopFrame();
		this.#drag = null;
		this.#value = null;
		this.#anchor = null;
		this.root.removeAttribute('data-selection-drag');
		this.highlights.setSelectionProjection(null);
		this.highlights.clearStructuralBoundaryGroup(GROUP);
		if (clearDom) {
			const selection = this.root.ownerDocument.getSelection();
			if (selection?.anchorNode && this.root.contains(selection.anchorNode))
				selection.removeAllRanges();
		}
		if (notify && changed) this.#notice({ kind: 'cancel' });
	}
	destroy() {
		this.#destroyed = true;
		this.#interaction.destroy();
		this.clear(true);
		this.#events.abort();
		this.#unsubscribe();
		controllers.delete(this.root);
		this.root.removeAttribute('data-source-selection-enabled');
	}
}
