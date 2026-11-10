<script lang="ts">
	import { onMount, tick, type Snippet } from 'svelte';
	import { setClerkContext, type ClerkContext } from 'svelte-clerk';
	import { deriveState } from '@clerk/shared/deriveState';
	import type { Resources } from '@clerk/shared/types';
	import { ReadAttempt, waitForRead } from './attempt';
	import { clerkScriptHead, waitForClerkScript } from './clerk-script';
	import { setClerkReadiness } from './clerk-readiness';
	import { recordStartup } from './startup-perf';

	let { publishableKey, children }: { publishableKey: string; children: Snippet } = $props();
	let clerk = $state<ClerkContext['clerk']>(null);
	let isLoaded = $state(false);
	let resources = $state<Resources>();
	const unloadedAuth: ClerkContext['auth'] = {
		userId: undefined,
		sessionId: undefined,
		actor: undefined,
		sessionStatus: undefined,
		sessionClaims: undefined,
		orgId: undefined,
		orgRole: undefined,
		orgSlug: undefined,
		orgPermissions: undefined,
		factorVerificationAge: null
	};
	const auth = $derived(resources ? deriveState(isLoaded, resources, undefined) : undefined);
	let status = $state<'starting' | 'ready' | 'error'>('starting');
	let error = $state('');
	let pending: Promise<void> | undefined;
	const scriptHead = $derived(clerkScriptHead(publishableKey));
	let attempt: ReadAttempt | undefined;
	let alive = false;
	let unsubscribe: (() => void) | undefined;

	async function load() {
		attempt?.abort();
		const current = new ReadAttempt(15_000);
		attempt = current;
		status = 'starting';
		error = '';
		try {
			const instance = await waitForClerkScript(publishableKey, current.signal);
			current.signal.throwIfAborted();
			recordStartup('clerk-script-available');
			// Our forms use Clerk's session API. Omit UI entirely: svelte-clerk 1.2.0
			// passes a promise resolving to undefined with prefetchUI=false, which
			// ClerkJS 6 attempts to construct and rejects during every startup.
			await waitForRead(
				instance.load({
					telemetry: false,
					signInUrl: '/login',
					signUpUrl: '/join',
					signInFallbackRedirectUrl: '/contracts',
					signUpFallbackRedirectUrl: '/contracts'
				}),
				current.signal
			);
			current.signal.throwIfAborted();
			if (!alive || attempt !== current) throw new Error('Sign-in was closed.');
			clerk = instance;
			unsubscribe?.();
			unsubscribe = instance.addListener((next) => {
				if (alive && attempt === current && !current.signal.aborted) resources = next;
			});
			isLoaded = true;
			// Flush the hooks subscribing to the newly available Clerk instance.
			await tick();
			current.signal.throwIfAborted();
			if (!alive || attempt !== current) throw new Error('Sign-in was closed.');
			status = 'ready';
			recordStartup('clerk-ready');
		} catch (cause) {
			if (alive && attempt === current) {
				status = 'error';
				error = 'Sign-in could not connect. Please try again.';
			}
			throw cause;
		} finally {
			current.complete();
		}
	}
	function initialize() {
		return (pending ??= load());
	}
	setClerkReadiness({
		get status() {
			return status;
		},
		get error() {
			return error;
		},
		ready: ({ signal }) => waitForRead(initialize(), signal),
		retry: () => {
			if (status === 'error') {
				pending = undefined;
			}
			return initialize();
		}
	});

	setClerkContext({
		get clerk() {
			return clerk;
		},
		get isLoaded() {
			return isLoaded;
		},
		get auth() {
			return auth ?? unloadedAuth;
		},
		get client() {
			return resources?.client;
		},
		get session() {
			return auth?.session;
		},
		get user() {
			return auth?.user;
		},
		get organization() {
			return auth?.organization;
		}
	});
	onMount(() => {
		alive = true;
		void initialize().catch(() => {});
		return () => {
			alive = false;
			attempt?.abort();
			unsubscribe?.();
		};
	});
</script>

<svelte:head>{@html scriptHead}</svelte:head>
{@render children()}
