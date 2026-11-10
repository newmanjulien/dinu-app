<script lang="ts">
	import type { Snippet } from 'svelte';
	import DocumentSkeleton from '$lib/components/document/DocumentSkeleton.svelte';

	let {
		loading = false,
		loadingLabel = 'Loading contract',
		withTools = true,
		children
	}: {
		loading?: boolean;
		loadingLabel?: string;
		withTools?: boolean;
		children?: Snippet;
	} = $props();
</script>

<main
	class={withTools
		? 'pt-[calc(var(--mobile-utility-rail-height)+16px)] pb-20 min-[1000px]:pt-5'
		: 'pt-2 pb-20 min-[1000px]:pt-5'}
	aria-label="Contract document"
	style:--buyer-link-bar-height="0px"
>
	{#if loading}
		<DocumentSkeleton embedded label={loadingLabel} />
	{:else}
		{@render children?.()}
	{/if}
</main>
