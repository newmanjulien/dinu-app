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
