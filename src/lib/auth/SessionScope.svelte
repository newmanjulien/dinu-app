<script lang="ts">
	import { browser } from '$app/environment';
	import { env } from '$env/dynamic/public';
	import { ConvexClient } from 'convex/browser';
	import { setConvexClientContext, _authContextKey } from 'convex-svelte';
	import { useClerkContext } from 'svelte-clerk';
	import { useViewerSession } from './viewer-session.svelte';
	import { ConvexSession } from './convex-session.svelte';
	import { ReadAttempt, waitForRead } from './attempt';
	import { useStartupPreparation } from './startup-preparation';
	import { recordStartup } from './startup-perf';
	import { onDestroy, setContext, untrack, type Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
	const clerk = useClerkContext();
	const owner = useViewerSession();
	const sessionId = untrack(() => clerk.auth.sessionId ?? clerk.session?.id);
	const transport = new ConvexSession(
		useStartupPreparation().take() ??
			new ConvexClient(env.PUBLIC_CONVEX_URL!, {
				disabled: !browser,
				initialAuthTokenReuse: true
			})
	);
	let authenticated = $state(false);
	let loading = $state(true);
	let configured = $state(false);
	let attempt = 0;
	let lifetime = new AbortController();
	let authentication: ReadAttempt | undefined;
	const initialGeneration = untrack(() => owner.transportGeneration);
	let generation = initialGeneration;
	setConvexClientContext(transport.client);
	setContext(_authContextKey, {
		get isLoading() {
			return owner.transportGeneration !== generation || loading;
		},
		get isAuthenticated() {
			return owner.transportGeneration === generation && authenticated;
		}
	});
	$effect(() => {
		const loaded = clerk.isLoaded;
		const currentSessionId = clerk.session?.id;
		const nextGeneration = owner.transportGeneration;
		untrack(() => {
			if (
				!loaded ||
				currentSessionId !== sessionId ||
				(configured && nextGeneration === generation)
			)
				return;
			const previous = authentication;
			authentication = undefined;
			previous?.abort();
			lifetime.abort();
			lifetime = new AbortController();
			if (nextGeneration !== generation) {
				void transport
					.replace(
						new ConvexClient(env.PUBLIC_CONVEX_URL!, {
							disabled: !browser,
							initialAuthTokenReuse: true
						})
					)
					.catch((error) => console.error('Unable to close the previous Convex client.', error));
				generation = nextGeneration;
			}
			if (!sessionId) {
				loading = false;
				authenticated = false;
				return;
			}
			const current = ++attempt;
			const signal = lifetime.signal;
			const initial = new ReadAttempt(15_000);
			authentication = initial;
			initial.signal.addEventListener(
				'abort',
				() => {
					if (current !== attempt || signal.aborted || authentication !== initial) return;
					lifetime.abort();
					authenticated = false;
					loading = false;
				},
				{ once: true }
			);
			loading = true;
			authenticated = false;
			transport.current.setAuth(
				async ({ forceRefreshToken }) => {
					if (current !== attempt || signal.aborted || clerk.session?.id !== sessionId) return null;
					const tokenAttempt = new ReadAttempt(15_000, signal);
					try {
						const skipCache = forceRefreshToken || generation !== initialGeneration;
						const token = await waitForRead(
							clerk.session!.getToken({ template: 'convex', skipCache }),
							tokenAttempt.signal
						);
						return current === attempt && !signal.aborted && clerk.session?.id === sessionId
							? token
							: null;
					} catch {
						if (current === attempt && !signal.aborted) {
							lifetime.abort();
							initial.complete();
							authenticated = false;
							loading = false;
						}
						return null;
					} finally {
						tokenAttempt.complete();
					}
				},
				(accepted) => {
					if (current !== attempt || signal.aborted || clerk.session?.id !== sessionId) return;
					initial.complete();
					if (accepted && loading) recordStartup('backend-authenticated');
					authenticated = accepted;
					loading = false;
				}
			);
			configured = true;
		});
	});
	$effect(() => {
		const isLoading = owner.transportGeneration !== generation || loading;
		const accepted = owner.transportGeneration === generation && authenticated;
		untrack(() => owner.reportAuth(isLoading, accepted));
	});
	onDestroy(() => {
		attempt++;
		lifetime.abort();
		authentication?.abort();
		void transport.close().catch((error) => console.error('Unable to close Convex.', error));
	});
</script>

{#if configured}{@render children()}{/if}
