<script lang="ts">
	import { setConvexClientContext } from 'convex-svelte';
	import { ConvexClient } from 'convex/browser';
	import { browser } from '$app/environment';
	import { env } from '$env/dynamic/public';
	import { onDestroy, onMount, type Snippet } from 'svelte';
	import { InteractionController, setInteractionController } from '$lib/components/ui/interactions';
	let { children }: { children: Snippet } = $props();
	const client = setConvexClientContext(
		new ConvexClient(env.PUBLIC_CONVEX_URL!, { disabled: !browser, unsavedChangesWarning: false })
	);
	const interactions = setInteractionController(new InteractionController());
	onMount(() => interactions.mount());
	onDestroy(() => {
		void client.close();
	});
</script>

{@render children()}
