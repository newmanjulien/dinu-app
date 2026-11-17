import { tick } from 'svelte';
import type { Action } from 'svelte/action';
export const focusComposer: Action<HTMLTextAreaElement> = (element) => {
	let alive = true,
		frame: number | undefined;
	void tick().then(() => {
		if (alive)
			frame = requestAnimationFrame(() => {
				if (alive && element.isConnected) element.focus({ preventScroll: true });
			});
	});
	return {
		destroy() {
			alive = false;
			if (frame !== undefined) cancelAnimationFrame(frame);
		}
	};
};

/** One focus boundary for the field and every action belonging to its composer. */
export const composerBoundary: Action<HTMLElement, (restoreFocus: boolean) => void> = (
	element,
	collapse
) => {
	let pointerTarget: Element | null = null;
	let pointerId: number | null = null;
	let deferredBlur = false;
	let releaseFrame: number | undefined;
	function finishPointerActivation() {
		if (releaseFrame !== undefined) cancelAnimationFrame(releaseFrame);
		releaseFrame = undefined;
		pointerTarget = null;
		pointerId = null;
		if (deferredBlur && !element.contains(document.activeElement)) collapse(false);
		deferredBlur = false;
	}
	function pointerdown(event: PointerEvent) {
		if (!event.isPrimary) return;
		if (pointerTarget) finishPointerActivation();
		pointerTarget =
			event.button === 0 && event.target instanceof Element
				? event.target.closest('[data-discussion-activate]')
				: null;
		pointerId = pointerTarget ? event.pointerId : null;
		deferredBlur = false;
	}
	function pointerup(event: PointerEvent) {
		if (event.pointerId !== pointerId) return;
		// A touch click may move focus after pointerup. Keep the card in place through click.
		releaseFrame = requestAnimationFrame(() => {
			releaseFrame = undefined;
			finishPointerActivation();
		});
	}
	function click() {
		finishPointerActivation();
	}
	function pointercancel(event: PointerEvent) {
		if (event.pointerId !== pointerId) return;
		finishPointerActivation();
	}
	function focusout(event: FocusEvent) {
		const next = event.relatedTarget;
		if (next instanceof Node && element.contains(next)) return;
		// Keep the cards in place until the target message's click selects its thread.
		if (pointerTarget?.isConnected) {
			deferredBlur = true;
			return;
		}
		collapse(false);
	}
	function keydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return;
		event.preventDefault();
		event.stopPropagation();
		collapse(true);
	}
	element.addEventListener('focusout', focusout);
	element.addEventListener('keydown', keydown);
	document.addEventListener('pointerdown', pointerdown, true);
	document.addEventListener('pointerup', pointerup, true);
	document.addEventListener('pointercancel', pointercancel, true);
	document.addEventListener('click', click);
	return {
		update(next) {
			collapse = next;
		},
		destroy() {
			element.removeEventListener('focusout', focusout);
			element.removeEventListener('keydown', keydown);
			document.removeEventListener('pointerdown', pointerdown, true);
			document.removeEventListener('pointerup', pointerup, true);
			document.removeEventListener('pointercancel', pointercancel, true);
			document.removeEventListener('click', click);
			if (releaseFrame !== undefined) cancelAnimationFrame(releaseFrame);
		}
	};
};
