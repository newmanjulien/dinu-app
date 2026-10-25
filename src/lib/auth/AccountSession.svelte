<script lang="ts">
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import { useClerkContext } from 'svelte-clerk';
	import { useViewerSession } from './viewer-session.svelte';
	import { loadComponent } from './component-loader.svelte';
	import { preloadDestination } from './destination-code';
	import { useStartupPreparation } from './startup-preparation';
	import type { Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
	const session = useViewerSession();
	const clerk = useClerkContext();
	const preparation = useStartupPreparation();
	const identity = $derived(clerk.auth.sessionId ?? clerk.session?.id);
	const required = $derived(!['/login', '/join'].includes(page.url.pathname));
	const workspaceRoute = $derived(page.route.id?.startsWith('/(workspace)') ?? false);
	const account = loadComponent(
		() => import('./AuthenticatedAccount.svelte'),
		() => browser && required && (workspaceRoute || Boolean(identity)),
		() => session.transportGeneration
	);
	const AuthenticatedAccount = $derived(account.component);
	$effect(() => {
		if (!browser) return;
		if (account.failed || (clerk.isLoaded && !identity)) preparation.cancel();
		else if (workspaceRoute && !AuthenticatedAccount) preparation.warm();
	});
	$effect(() => {
		if (browser && required && (workspaceRoute || identity))
			void preloadDestination(page.url.pathname).catch(() => {});
	});
</script>

{#if browser && identity && session.prepared === identity && !session.closing && AuthenticatedAccount}
	{#key identity}
		<AuthenticatedAccount>{@render children()}</AuthenticatedAccount>
	{/key}
{:else}
	{@render children()}
	{#if account.failed && required && identity}
		<div role="alert" class="fixed inset-x-0 bottom-0 bg-white p-4 text-center text-sm">
			We couldn’t load your account. Please try again.
			<button class="underline" onclick={() => session.retryAuth()}>Try again</button>
			<button class="ml-4 underline" onclick={() => void session.signOut()}>Log out</button>
		</div>
	{/if}
{/if}
