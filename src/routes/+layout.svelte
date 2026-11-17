<script lang="ts">
	import '../app.css';
	import editorialFont from '@fontsource/newsreader/files/newsreader-latin-400-normal.woff2?url';
	import { page } from '$app/state';
	import { describeRoute } from '$lib/auth/routes';
	import { isBuyerPath } from '$lib/buyer/urls';
	import { setPageMetadata } from '$lib/auth/page-metadata.svelte';
	import { env } from '$env/dynamic/public';
	import AuthBridge from '$lib/auth/AuthBridge.svelte';
	import AccountSession from '$lib/auth/AccountSession.svelte';
	import StartupDataProvider from '$lib/auth/StartupDataProvider.svelte';
	import ClerkSessionProvider from '$lib/auth/ClerkSessionProvider.svelte';
	import { setStartupPreparation } from '$lib/auth/startup-preparation';
	import {
		setDocumentNavigation,
		type DocumentScrollSnapshot
	} from '$lib/document/runtime/navigation.svelte';
	import { onDestroy } from 'svelte';
	let { children } = $props();
	const preparation = setStartupPreparation();
	const documentNavigation = setDocumentNavigation();
	export const snapshot = {
		capture: (): DocumentScrollSnapshot => documentNavigation.capture(),
		restore: (value: DocumentScrollSnapshot) => documentNavigation.restore(value)
	};
	const metadata = setPageMetadata();
	const route = $derived(describeRoute(page.route.id));
	const tabTitle = $derived.by(() => {
		const override = metadata.override;
		const currentOverride =
			override?.routeId === page.route.id && override.pathname === page.url.pathname
				? override.title
				: undefined;
		if (route.presentation === 'buyer-document')
			return currentOverride === 'View contract as buyer' &&
				page.data.resolvedRouteTitle?.kind === 'current'
				? currentOverride
				: (page.data.resolvedRouteTitle?.title ?? '');
		if (route.document === 'saved') return page.data.resolvedRouteTitle?.title ?? '';
		if (currentOverride) return currentOverride;
		return route.title;
	});
	onDestroy(() => preparation.cancel());
</script>

<svelte:head>
	<link rel="preload" href={editorialFont} as="font" type="font/woff2" crossorigin="anonymous" />
	<title>{tabTitle}</title>
	<meta name="description" content={route.description ?? ''} />
</svelte:head>

{#if isBuyerPath(page.url.pathname) && env.PUBLIC_CONVEX_URL}
	{@render children()}
{:else if env.PUBLIC_CLERK_PUBLISHABLE_KEY && env.PUBLIC_CONVEX_URL}
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
