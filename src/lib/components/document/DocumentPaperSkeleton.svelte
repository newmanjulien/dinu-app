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
		class="aspect-(--paper-ratio) w-full overflow-hidden bg-surface shadow-card outline-(length:--surface-border-width) outline-edge outline-offset-[calc(-1*var(--surface-border-width))]"
		aria-hidden="true"
		style:--paper-ratio={`${PAGE_FORMAT.width} / ${PAGE_FORMAT.height}`}
		style:--paper-padding={`${(PAGE_FORMAT.horizontalPadding / PAGE_FORMAT.width) * 100}%`}
		style:--paper-top-padding={`${(PAGE_FORMAT.firstTopPadding / PAGE_FORMAT.width) * 100}%`}
	>
		<div class="px-(--paper-padding) py-(--paper-top-padding)">
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
