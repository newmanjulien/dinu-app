<script lang="ts">
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	import { PAGE_FORMAT } from '$lib/document/pagination/page-format';
	let {
		label = 'Laying out document pages',
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
		style:font-size={`calc(var(--paper-width) * 16 / ${PAGE_FORMAT.width})`}
	>
		<div class="px-(--paper-padding) py-(--paper-top-padding)">
			<SkeletonBlock class="mx-auto mb-[2.5em] h-[1.4375em] w-1/2" />
			{#each [0, 1, 2, 3] as paragraph (paragraph)}
				<div class="mb-[2em] space-y-[0.75em]">
					<SkeletonBlock class="mb-[1em] h-[1.0625em] w-1/3" />
					<SkeletonBlock class="h-[0.8125em] w-full" />
					<SkeletonBlock class="h-[0.8125em] w-[95%]" />
					<SkeletonBlock class="h-[0.8125em] w-full" />
					<SkeletonBlock class="h-[0.8125em] w-3/4" />
				</div>
			{/each}
		</div>
	</div>
</div>
