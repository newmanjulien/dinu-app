import { useConvexClient } from 'convex-svelte';
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';
import { untrack } from 'svelte';
import type { SnapshotClient } from '$lib/query-once';

/** A region owns one bounded subscription attempt; its form and accepted display outlive retries. */
export function useReadQuery<Q extends FunctionReference<'query'>>(
	query: Q,
	args: FunctionArgs<Q> | (() => FunctionArgs<Q> | 'skip'),
	generation: () => unknown = () => undefined
) {
	return createReadQuery(useConvexClient(), query, args, generation);
}

/** Also usable by explicit lifecycle owners outside component initialization. */
export function createReadQuery<Q extends FunctionReference<'query'>>(
	client: SnapshotClient,
	query: Q,
	args: FunctionArgs<Q> | (() => FunctionArgs<Q> | 'skip'),
	generation: () => unknown = () => undefined
) {
	let revision = $state(0);
	let data = $state.raw<FunctionReturnType<Q>>();
	let error = $state.raw<Error>();
	let pending = $state(false);
	let rejected = $state(false);
	let acceptedKey = $state<string>();
	let attemptVersion = $state.raw<{ revision: number; generation: unknown }>();
	const input = $derived.by(() => {
		const current = typeof args === 'function' ? (args as () => FunctionArgs<Q> | 'skip')() : args;
		return { current, key: current === 'skip' ? undefined : JSON.stringify(current) };
	});
	$effect(() => {
		const version = { revision, generation: generation() };
		const { current, key } = input;
		// Read the proxy here so replacing its transport also replaces this subscription.
		const subscribe = client.onUpdate;
		let active = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const release = untrack(() => {
			attemptVersion = version;
			if (key !== acceptedKey) {
				data = undefined;
				rejected = false;
			}
			acceptedKey = key;
			error = undefined;
			pending = key !== undefined;
			if (current === 'skip') return;
			const accept = (value: FunctionReturnType<Q>) => {
				if (!active) return;
				clearTimeout(timer);
				data = value;
				error = undefined;
				pending = false;
				rejected = false;
			};
			const fail = (cause: unknown) => {
				if (!active) return;
				clearTimeout(timer);
				data = undefined;
				error = cause instanceof Error ? cause : new Error('The request failed. Please try again.');
				pending = false;
				rejected = true;
			};
			const subscription = subscribe.call(client, query, current, accept, fail);
			try {
				const cached = subscription.getCurrentValue?.();
				if (cached !== undefined) accept(cached);
			} catch (cause) {
				fail(cause);
			}
			if (pending)
				timer = setTimeout(() => {
					if (active) {
						pending = false;
						error = new Error('The request timed out. Please try again.');
					}
				}, 15_000);
			return subscription;
		});
		return () => {
			active = false;
			clearTimeout(timer);
			release?.();
		};
	});
	return {
		/** Settled preflight data; retained display from an earlier attempt is not eligible. */
		get currentData() {
			return input.key !== undefined &&
				input.key === acceptedKey &&
				attemptVersion?.revision === revision &&
				attemptVersion.generation === generation() &&
				!pending &&
				!error &&
				!rejected
				? data
				: undefined;
		},
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
