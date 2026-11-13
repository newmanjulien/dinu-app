<script lang="ts">
	import { onMount } from 'svelte';
	import { setBuyerActivity } from '$lib/buyer/activity.svelte';
	import { page } from '$app/state';
	import AnonymousProvider from '$lib/buyer/AnonymousProvider.svelte';
	import BuyerShell from '$lib/buyer/BuyerShell.svelte';
	let { children, data } = $props();
	const activity = setBuyerActivity();
	onMount(() => activity.mount());
</script>

<AnonymousProvider
	>{#key page.params.token}<BuyerShell
			token={page.params.token!}
			browser={data.activityBrowser}
			hasAccountSession={data.hasAccountSession}>{@render children()}</BuyerShell
		>{/key}</AnonymousProvider
>
