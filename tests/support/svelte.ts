import { flushSync, tick } from 'svelte';
import { vi } from 'vitest';

// Drain Svelte/microtasks only. No clocks or transport responses advance implicitly.
export async function settle() {
	for (let i = 0; i < 5; i++) {
		flushSync();
		await tick();
		await Promise.resolve();
	}
}

export function frameClock() {
	let id = 0;
	const frames = new Map<number, FrameRequestCallback>();
	vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
		frames.set(++id, callback);
		return id;
	});
	vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
	return {
		frames,
		async frame() {
			const batch = [...frames.values()];
			frames.clear();
			for (const callback of batch) callback(performance.now());
			await settle();
		}
	};
}
