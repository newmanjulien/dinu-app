import { useConvexClient } from 'convex-svelte';
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';
import { untrack } from 'svelte';

/** A region owns one bounded subscription attempt; its form and accepted display outlive retries. */
export function useReadQuery<Q extends FunctionReference<'query'>>(
	query: Q,
	args: FunctionArgs<Q> | (() => FunctionArgs<Q> | 'skip'),
	generation: () => unknown = () => undefined
) {
	const client = useConvexClient();
	let revision = $state(0);
	let data = $state.raw<FunctionReturnType<Q>>();
	let error = $state.raw<Error>();
	let pending = $state(false);
	let rejected = $state(false);
	let acceptedKey = $state<string>();
	const input = $derived.by(() => {
		const current = typeof args === 'function' ? (args as () => FunctionArgs<Q> | 'skip')() : args;
		return { current, key: current === 'skip' ? undefined : JSON.stringify(current) };
	});
	$effect(() => {
		void revision;
		generation();
		const { current, key } = input;
		// Read the proxy here so replacing its transport also replaces this subscription.
		const subscribe = client.onUpdate;
		let active = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const release = untrack(() => {
			if (key !== acceptedKey) {
				data = undefined;
				rejected = false;
			}
			acceptedKey = key;
			error = undefined;
			pending = key !== undefined;
			if (current === 'skip') return;
			timer = setTimeout(() => {
				if (active) {
					pending = false;
					error = new Error('The request timed out. Please try again.');
				}
			}, 15_000);
			return subscribe.call(
				client,
				query,
				current,
				(value: FunctionReturnType<Q>) => {
					if (!active) return;
					clearTimeout(timer);
					data = value;
					error = undefined;
					pending = false;
					rejected = false;
				},
				(cause: Error) => {
					if (!active) return;
					clearTimeout(timer);
					data = undefined;
					error = cause;
					pending = false;
					rejected = true;
				}
			);
		});
		return () => {
			active = false;
			clearTimeout(timer);
			release?.();
		};
	});
	return {
		get data() {
			return input.key !== undefined && input.key === acceptedKey ? data : undefined;
		},
		get error() {
			return input.key === acceptedKey ? error : undefined;
		},
		get rejected() {
			return input.key === acceptedKey && rejected;
		},
		get isLoading() {
			return input.key !== undefined && (input.key !== acceptedKey || pending);
		},
		get isStale() {
			return input.key === acceptedKey && pending && data !== undefined;
		},
		retry: () => {
			revision++;
		}
	};
}
