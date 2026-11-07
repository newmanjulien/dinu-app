export interface CapturedNativeSelection {
	readonly range: Range;
	readonly anchor: { node: Node; offset: number };
	readonly focus: { node: Node; offset: number };
	readonly backward: boolean;
	readonly session: object;
	readonly context: object;
}
export function captureNativeSelection(
	range: Range,
	anchor: { node: Node; offset: number },
	focus: { node: Node; offset: number },
	session: object,
	context: object
): CapturedNativeSelection {
	const direction = range.cloneRange();
	direction.setStart(anchor.node, anchor.offset);
	direction.setEnd(focus.node, focus.offset);
	return {
		range: range.cloneRange(),
		anchor,
		focus,
		backward: direction.collapsed && (anchor.node !== focus.node || anchor.offset !== focus.offset),
		session,
		context
	};
}
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
export interface SelectionMouseGesture {
	start: (event: MouseEvent) => void;
	move: (event: PointerEvent) => void;
	finish: (event: PointerEvent | undefined, cancelled: boolean) => void;
}
export function isDocumentControl(target: EventTarget | null) {
	return (
		target instanceof Element &&
		Boolean(
			target.closest(
				'[data-document-control], [data-document-chrome], [popover], button, a, input, textarea, select'
			)
		)
	);
}
export function isKeyboardSelectionEvent(event: KeyboardEvent) {
	return (
		(event.shiftKey && NAVIGATION_KEYS.has(event.key)) ||
		((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a')
	);
}

/** Exclusive input sessions. Mouse claiming waits for the real compatibility mousedown. */
export function createSelectionInteraction({
	context,
	onNativeStart,
	onNativeComplete,
	onCancel,
	onMouseStart,
	onNavigation
}: {
	context: object;
	onNativeStart: (event?: KeyboardEvent) => void;
	onNativeComplete: (selection: CapturedNativeSelection | null) => void;
	onCancel: () => void;
	onMouseStart?: (event: PointerEvent) => SelectionMouseGesture | null;
	onNavigation?: (event: KeyboardEvent) => void;
}) {
	let container: HTMLElement | undefined;
	let phase: 'idle' | 'pending' | 'native' | 'mouse' | 'completing' = 'idle';
	let pointerId: number | undefined,
		frame: number | undefined,
		generation = 0;
	let mouse: SelectionMouseGesture | undefined;
	let pending: PointerEvent | undefined;
	let nativeSession: object = {};
	let listeners: AbortController | undefined;
	const contains = (target: EventTarget | null) =>
		target instanceof Node && Boolean(container?.contains(target));
	function currentRange() {
		const selection = window.getSelection();
		return selection &&
			!selection.isCollapsed &&
			selection.rangeCount === 1 &&
			contains(selection.anchorNode) &&
			contains(selection.focusNode)
			? captureNativeSelection(
					selection.getRangeAt(0),
					{ node: selection.anchorNode!, offset: selection.anchorOffset },
					{ node: selection.focusNode!, offset: selection.focusOffset },
					nativeSession,
					context
				)
			: null;
	}
	function reset() {
		generation++;
		if (frame !== undefined) cancelAnimationFrame(frame);
		frame = undefined;
		const released = pointerId;
		// Mark completion before releasePointerCapture can synchronously deliver lostcapture.
		phase = 'idle';
		pointerId = undefined;
		pending = undefined;
		mouse = undefined;
		if (released !== undefined && container?.hasPointerCapture?.(released))
			container.releasePointerCapture(released);
	}
	function cancel() {
		const active = phase !== 'idle',
			gesture = phase === 'mouse' ? mouse : undefined;
		reset();
		gesture?.finish(undefined, true);
		if (active) onCancel();
	}
	function beginNative(event?: KeyboardEvent) {
		phase = 'native';
		nativeSession = {};
		pending = undefined;
		mouse = undefined;
		onNativeStart(event);
	}
	function completeNative() {
		phase = 'completing';
		if (frame !== undefined) cancelAnimationFrame(frame);
		const token = generation;
		frame = requestAnimationFrame(() => {
			frame = undefined;
			if (token !== generation || phase !== 'completing') return;
			const range = currentRange();
			reset();
			onNativeComplete(range);
		});
	}
	function pointerDown(event: PointerEvent) {
		if (
			!event.isPrimary ||
			event.button !== 0 ||
			!contains(event.target) ||
			isDocumentControl(event.target)
		)
			return;
		if (event.defaultPrevented) {
			if (phase === 'idle') onCancel();
			else cancel();
			return;
		}
		if (phase !== 'idle') cancel();
		pointerId = event.pointerId;
		const candidate =
			event.pointerType === 'mouse' && !event.ctrlKey && !event.metaKey && !event.altKey
				? onMouseStart?.(event)
				: null;
		if (candidate) {
			pending = event;
			mouse = candidate;
			phase = 'pending';
		} else beginNative();
	}
	function mouseDown(event: MouseEvent) {
		if (phase !== 'pending' || !pending) return;
		// PointerEvent.detail is always zero. Canceling pointerdown would suppress this event.
		if (event.detail > 1 && event.target === pending.target && !event.defaultPrevented) {
			beginNative();
			return;
		}
		if (
			event.detail !== 1 ||
			!event.cancelable ||
			event.defaultPrevented ||
			event.button !== 0 ||
			event.target !== pending.target
		) {
			cancel();
			return;
		}
		event.preventDefault();
		phase = 'mouse';
		pending = undefined;
		mouse!.start(event);
		if (phase === 'mouse' && pointerId !== undefined) {
			try {
				container?.setPointerCapture?.(pointerId);
			} catch {
				cancel();
			}
		}
	}
	function pointerUp(event: PointerEvent) {
		if (pointerId !== event.pointerId) return;
		if (phase === 'mouse') {
			const gesture = mouse;
			reset();
			gesture?.finish(event, false);
			return;
		}
		if (phase === 'pending') {
			cancel();
			return;
		}
		if (phase !== 'native') return;
		pointerId = undefined;
		completeNative();
	}
	function pointerMove(event: PointerEvent) {
		if (phase === 'mouse' && pointerId === event.pointerId) mouse?.move(event);
	}
	function pointerCancel(event: PointerEvent) {
		if (pointerId === event.pointerId) cancel();
	}
	function keyDown(event: KeyboardEvent) {
		if (
			event.defaultPrevented ||
			!contains(event.target) ||
			isDocumentControl(event.target) ||
			document.querySelector('dialog:modal')
		)
			return;
		if (event.key === 'Escape') {
			cancel();
			onNavigation?.(event);
			return;
		}
		if (pointerId !== undefined) return;
		if (isKeyboardSelectionEvent(event)) {
			if (phase !== 'native') {
				reset();
				beginNative(event);
			}
		} else if (NAVIGATION_KEYS.has(event.key)) onNavigation?.(event);
	}
	function keyUp(event: KeyboardEvent) {
		if (phase === 'native' && pointerId === undefined && (event.key === 'Shift' || !event.shiftKey))
			completeNative();
	}
	function external(event: Event) {
		if (phase !== 'idle' && !contains(event.target)) cancel();
	}
	function setContainer(next: HTMLElement | undefined) {
		if (container === next) return;
		cancel();
		listeners?.abort();
		container = next;
		if (!container) return;
		listeners = new AbortController();
		const options = { signal: listeners.signal };
		container.addEventListener('pointerdown', pointerDown, { ...options, capture: true });
		container.addEventListener('mousedown', mouseDown, { ...options, capture: true });
		container.addEventListener('lostpointercapture', pointerCancel, options);
		window.addEventListener('pointermove', pointerMove, options);
		window.addEventListener('pointerup', pointerUp, options);
		window.addEventListener('pointercancel', pointerCancel, options);
		window.addEventListener('blur', cancel, options);
		document.addEventListener('pointerdown', external, { ...options, capture: true });
		document.addEventListener('focusin', external, { ...options, capture: true });
		document.addEventListener('keydown', keyDown, { ...options, capture: true });
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
			cancel();
			listeners?.abort();
			container = undefined;
		}
	};
}
