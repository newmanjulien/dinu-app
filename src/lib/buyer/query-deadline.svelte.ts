import { untrack } from 'svelte';

/** A pending region gets one budget per request, query identity, and transport. */
export function useQueryDeadline(pending: () => boolean, generation: () => unknown) {
	let error = $state<Error>();
	const identity = $derived(JSON.stringify(generation()));
	const waiting = $derived(pending());
	$effect(() => {
		const key = identity;
		untrack(() => (error = undefined));
		if (!waiting) return;
		const timer = setTimeout(() => {
			if (identity === key && waiting)
				error = new Error('The request timed out. Please try again.');
		}, 15_000);
		return () => clearTimeout(timer);
	});
	return {
		get error() {
			return error;
		}
	};
}
