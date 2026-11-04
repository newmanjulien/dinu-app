const NAVIGATION_KEYS = new Set([
	'ArrowLeft',
	'ArrowRight',
	'ArrowUp',
	'ArrowDown',
	'Home',
	'End',
	'PageUp',
	'PageDown'
]);

type Phase = 'idle' | 'native-selecting' | 'boundary-selecting' | 'completing';

export interface SelectionBoundaryGesture {
	start: () => void;
	move: (event: PointerEvent) => void;
	finish: (event: PointerEvent | undefined, cancelled: boolean) => void;
}

function isDocumentControl(target: EventTarget | null) {
	return (
		target instanceof Element &&
		Boolean(target.closest('[data-document-control], button, a, input, textarea, select'))
	);
}

function isKeyboardSelectionEvent(event: KeyboardEvent) {
	return (
		(event.shiftKey && NAVIGATION_KEYS.has(event.key)) ||
		((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a')
	);
}

/**
 * Owns one native-selection gesture at a time. It captures and maps the browser range exactly
 * once after pointer/key input completes, so programmatic selections, stale candidates, and
 * arbitrary timers cannot become authoring input.
 */
export function createSelectionInteraction({
	onNativeStart,
	onNativeComplete,
	onCancel,
	onBoundaryStart
}: {
	onNativeStart: () => void;
	onNativeComplete: (range: Range | null) => void;
	onCancel: () => void;
	onBoundaryStart: (event: PointerEvent) => SelectionBoundaryGesture | null;
}) {
	let container: HTMLElement | undefined;
	let phase: Phase = 'idle';
	let pointerId: number | undefined;
	let frame: number | undefined;
	let generation = 0;
	let boundary: SelectionBoundaryGesture | undefined;
	let listeners: AbortController | undefined;
	let boundaryListeners: AbortController | undefined;

	function contains(target: EventTarget | null) {
		return target instanceof Node && Boolean(container?.contains(target));
	}

	function currentRange(): Range | null {
		const selection = window.getSelection();
		if (
			!selection ||
			selection.isCollapsed ||
			selection.rangeCount !== 1 ||
			!contains(selection.anchorNode) ||
			!contains(selection.focusNode)
		)
			return null;
		return selection.getRangeAt(0).cloneRange();
	}

	function clearBoundaryListeners() {
		boundaryListeners?.abort();
		boundaryListeners = undefined;
	}

	function clearCompletion() {
		if (frame !== undefined) cancelAnimationFrame(frame);
		frame = undefined;
	}

	function releasePointer() {
		if (pointerId === undefined || !container?.hasPointerCapture?.(pointerId)) return;
		container.releasePointerCapture(pointerId);
	}

	function reset() {
		generation++;
		clearCompletion();
		clearBoundaryListeners();
		releasePointer();
		pointerId = undefined;
		boundary = undefined;
		phase = 'idle';
	}

	function cancel() {
		const activeBoundary = phase === 'boundary-selecting' ? boundary : undefined;
		const active = phase !== 'idle';
		reset();
		activeBoundary?.finish(undefined, true);
		if (active) onCancel();
	}

	function beginNative(event?: PointerEvent) {
		if (phase !== 'idle') cancel();
		else reset();
		phase = 'native-selecting';
		pointerId = event?.pointerId;
		onNativeStart();
	}

	function completeNativeSelection() {
		if (phase !== 'native-selecting' && phase !== 'completing') return;
		phase = 'completing';
		clearCompletion();
		const token = generation;
		frame = requestAnimationFrame(() => {
			frame = undefined;
			if (token !== generation || phase !== 'completing') return;
			const range = currentRange();
			reset();
			onNativeComplete(range);
		});
	}

	function finishBoundary(event: PointerEvent | undefined, cancelled: boolean) {
		if (phase !== 'boundary-selecting' || !boundary) return;
		const activeBoundary = boundary;
		reset();
		activeBoundary.finish(event, cancelled);
		if (cancelled) onCancel();
	}

	function pointerDown(event: PointerEvent) {
		if (
			event.defaultPrevented ||
			!event.isPrimary ||
			event.button !== 0 ||
			!contains(event.target) ||
			isDocumentControl(event.target)
		)
			return;
		const nextBoundary = onBoundaryStart(event);
		if (nextBoundary) {
			event.preventDefault();
			if (phase !== 'idle') cancel();
			else reset();
			phase = 'boundary-selecting';
			pointerId = event.pointerId;
			boundary = nextBoundary;
			onNativeStart();
			nextBoundary.start();
			container?.setPointerCapture?.(event.pointerId);
			const controller = new AbortController();
			boundaryListeners = controller;
			const options = { signal: controller.signal };
			document.addEventListener('scroll', () => finishBoundary(undefined, true), {
				...options,
				capture: true,
				passive: true
			});
			window.addEventListener('resize', () => finishBoundary(undefined, true), {
				...options,
				passive: true
			});
			return;
		}
		beginNative(event);
	}

	function pointerUp(event: PointerEvent) {
		if (pointerId !== event.pointerId) return;
		if (phase === 'boundary-selecting') {
			finishBoundary(event, false);
			return;
		}
		pointerId = undefined;
		completeNativeSelection();
	}

	function pointerMove(event: PointerEvent) {
		if (phase === 'boundary-selecting' && pointerId === event.pointerId) boundary?.move(event);
	}

	function pointerCancel(event: PointerEvent) {
		if (pointerId !== event.pointerId) return;
		if (phase === 'boundary-selecting') finishBoundary(event, true);
		else cancel();
	}

	function keyDown(event: KeyboardEvent) {
		if (
			event.defaultPrevented ||
			document.querySelector('dialog:modal') ||
			pointerId !== undefined ||
			!isKeyboardSelectionEvent(event) ||
			!contains(event.target) ||
			isDocumentControl(event.target)
		)
			return;
		if (phase !== 'native-selecting') beginNative();
	}

	function keyUp(event: KeyboardEvent) {
		if (phase !== 'native-selecting' || pointerId !== undefined) return;
		if (event.key === 'Shift' || !event.shiftKey) completeNativeSelection();
	}

	function externalPointerDown(event: PointerEvent) {
		if (phase !== 'idle' && !contains(event.target)) cancel();
	}

	function externalFocus(event: FocusEvent) {
		if (phase !== 'idle' && !contains(event.target)) cancel();
	}

	function setContainer(next: HTMLElement | undefined) {
		if (container === next) return;
		if (phase !== 'idle') cancel();
		listeners?.abort();
		listeners = undefined;
		container = next;
		if (!container) return;
		const controller = new AbortController();
		listeners = controller;
		const options = { signal: controller.signal };
		container.addEventListener('pointerdown', pointerDown, { ...options, capture: true });
		window.addEventListener('pointermove', pointerMove, { ...options, passive: true });
		window.addEventListener('pointerup', pointerUp, { ...options, passive: true });
		window.addEventListener('pointercancel', pointerCancel, { ...options, passive: true });
		window.addEventListener('blur', cancel, options);
		document.addEventListener('pointerdown', externalPointerDown, { ...options, capture: true });
		document.addEventListener('focusin', externalFocus, { ...options, capture: true });
		document.addEventListener('keydown', keyDown, options);
		document.addEventListener('keyup', keyUp, options);
	}

	return {
		setContainer,
		get selecting() {
			return phase !== 'idle';
		},
		reset,
		cancel,
		destroy() {
			if (phase !== 'idle') cancel();
			listeners?.abort();
			listeners = undefined;
			container = undefined;
		}
	};
}
