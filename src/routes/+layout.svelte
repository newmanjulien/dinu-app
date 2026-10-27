<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import { describeRoute } from '$lib/auth/routes';
	import { setPageMetadata } from '$lib/auth/page-metadata.svelte';
	import { env } from '$env/dynamic/public';
	import AuthBridge from '$lib/auth/AuthBridge.svelte';
	import AccountSession from '$lib/auth/AccountSession.svelte';
	import StartupDataProvider from '$lib/auth/StartupDataProvider.svelte';
	import ClerkSessionProvider from '$lib/auth/ClerkSessionProvider.svelte';
	import { setStartupPreparation } from '$lib/auth/startup-preparation';
	import { onDestroy } from 'svelte';
	let { children } = $props();
	const preparation = setStartupPreparation();
	const metadata = setPageMetadata();
	const route = $derived(describeRoute(page.route.id));
	onDestroy(() => preparation.cancel());
</script>

<svelte:head>
	<title
		>{metadata.override?.routeId === page.route.id ? metadata.override.title : route.title}</title
	>
	<meta name="description" content={route.description ?? ''} />
</svelte:head>

{#if env.PUBLIC_CLERK_PUBLISHABLE_KEY && env.PUBLIC_CONVEX_URL}
	<ClerkSessionProvider publishableKey={env.PUBLIC_CLERK_PUBLISHABLE_KEY}>
		<AuthBridge
			><StartupDataProvider
				><AccountSession>{@render children()}</AccountSession></StartupDataProvider
			></AuthBridge
		>
	</ClerkSessionProvider>
{:else}
	<main class="grid min-h-dvh place-content-center bg-white p-8 text-center">
		<h1 class="text-sm font-medium">Dinu</h1>
		<p class="mt-3 text-sm text-ink-muted">
			Sign-in setup is pending. Add the development Clerk keys to open Dinu.
		</p>
	</main>
{/if}
