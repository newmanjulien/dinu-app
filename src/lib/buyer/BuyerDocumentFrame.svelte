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

<main
	aria-label="Contract document"
	style:--buyer-link-bar-height="0px"
	style:--document-section-bottom-padding="80px"
>
	{#if loading}
		<DocumentSkeleton label={loadingLabel} />
	{:else}
		{@render children?.()}
	{/if}
</main>
