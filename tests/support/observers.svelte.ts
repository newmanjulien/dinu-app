import { untrack } from 'svelte';

/** Exercise the same Svelte dependency tracking used by workspace effects. */
export function observe<T>(read: () => T, accept: (value: T) => void) {
	return $effect.root(() => {
		$effect(() => {
			const value = read();
			untrack(() => accept(value));
		});
	});
}

export function reactive<T extends object>(value: T): T {
	const state = $state(value);
	return state;
}
