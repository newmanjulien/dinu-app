<script lang="ts">
	import type { Snippet } from 'svelte';
	import DocumentSkeleton from '$lib/components/document/DocumentSkeleton.svelte';

	let {
		loading = false,
		loadingLabel = 'Loading contract',
		children
	}: {
		loading?: boolean;
		loadingLabel?: string;
		children?: Snippet;
	} = $props();
</script>

<main class="pb-20" aria-label="Contract document" style:--buyer-link-bar-height="0px">
	{#if loading}
		<DocumentSkeleton embedded label={loadingLabel} />
	{:else}
		{@render children?.()}
	{/if}
</main>
