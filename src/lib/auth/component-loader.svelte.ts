import { untrack } from 'svelte';

/**
 * Load code independently of admission. Unlike data reads, module imports cannot be
 * cancelled, so a stale attempt is simply ignored when it eventually settles.
 */
export function loadModule<T>(
	load: () => Promise<T> | T,
	enabled: () => boolean,
	generation: () => unknown = () => undefined
) {
	let module = $state.raw<T>();
	let failed = $state(false);
	let retry = $state(0);
	$effect(() => {
		generation();
		void retry;
		if (!enabled() || module) return;
		let active = true;
		untrack(() => {
			failed = false;
		});
		void Promise.resolve()
			.then(load)
			.then((loaded) => {
				if (active) module = loaded;
			})
			.catch((cause: unknown) => {
				if (!active) return;
				failed = true;
				if (import.meta.env.DEV) console.error('Unable to load lazy code.', cause);
			});
		return () => {
			active = false;
		};
	});
	return {
		get module() {
			return module;
		},
		get failed() {
			return failed;
		},
		retry: () => retry++
	};
}

/** Load component code independently of the caller's decision to mount it. */
export function loadComponent<T>(
	load: () => Promise<{ default: T }> | { default: T },
	enabled: () => boolean,
	generation: () => unknown = () => undefined
) {
	const lazy = loadModule<{ default: T }>(load, enabled, generation);
	return {
		get component() {
			return lazy.module?.default;
		},
		get failed() {
			return lazy.failed;
		},
		retry: lazy.retry
	};
}
