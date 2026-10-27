<script lang="ts">
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	import { PAGE_FORMAT } from '$lib/document/pagination/page-format';
	let {
		label = 'Laying out contract pages',
		announce = true
	}: { label?: string; announce?: boolean } = $props();
</script>

{#if announce}<span role="status" class="sr-only">{label}</span>{/if}
<div data-testid="pagination-loading">
	<div
		class="paper"
		aria-hidden="true"
		style:--paper-ratio={`${PAGE_FORMAT.width} / ${PAGE_FORMAT.height}`}
		style:--paper-padding={`${(PAGE_FORMAT.horizontalPadding / PAGE_FORMAT.width) * 100}%`}
		style:--paper-top-padding={`${(PAGE_FORMAT.firstTopPadding / PAGE_FORMAT.width) * 100}%`}
	>
		<div class="paper-content">
			<SkeletonBlock class="mx-auto mb-10 h-[23px] w-1/2" />
			{#each [0, 1, 2, 3] as paragraph (paragraph)}
				<div class="mb-8 space-y-3">
					<SkeletonBlock class="mb-4 h-[17px] w-1/3" />
					<SkeletonBlock class="h-[13px] w-full" />
					<SkeletonBlock class="h-[13px] w-[95%]" />
					<SkeletonBlock class="h-[13px] w-full" />
					<SkeletonBlock class="h-[13px] w-3/4" />
				</div>
			{/each}
		</div>
	</div>
</div>

<style>
	.paper {
		width: 100%;
		aspect-ratio: var(--paper-ratio);
		overflow: hidden;
		outline: var(--surface-border-width) solid var(--color-edge);
		outline-offset: calc(-1 * var(--surface-border-width));
		background: var(--color-surface);
		box-shadow: var(--shadow-card);
	}
	.paper-content {
		padding: var(--paper-top-padding) var(--paper-padding);
	}
</style>
