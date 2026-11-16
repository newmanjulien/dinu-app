<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { setBuyerActivity } from '$lib/buyer/activity.svelte';
	import { page } from '$app/state';
	import AnonymousProvider from '$lib/buyer/AnonymousProvider.svelte';
	import BuyerShell from '$lib/buyer/BuyerShell.svelte';
	import Button from '$lib/ui/Button.svelte';
	let { children, data } = $props();
	const activity = setBuyerActivity();
	onMount(() => activity.mount());
</script>

{#if data.resolvedRouteTitle.kind !== 'current'}
	<main class="mx-auto max-w-md px-6 py-16 text-center">
		<h1 class="text-lg font-medium">{data.resolvedRouteTitle.title}</h1>
		<p class="mt-3 text-sm text-ink-muted">
			{data.resolvedRouteTitle.kind === 'unavailable'
				? 'Check the link or ask for the latest one.'
				: 'Please try again to open this contract.'}
		</p>
		<Button variant="secondary" class="mt-5" onclick={() => void invalidateAll()}>Try again</Button>
	</main>
{:else}
	<AnonymousProvider
		>{#key page.params.token}<BuyerShell
				token={page.params.token!}
				browser={data.activityBrowser}
				hasAccountSession={data.hasAccountSession || data.resolvedRouteTitle.audience === 'seller'}
				>{@render children()}</BuyerShell
			>{/key}</AnonymousProvider
	>
{/if}
