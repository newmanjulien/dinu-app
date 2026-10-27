<script lang="ts">
	import '$lib/styles/contract-card-grid.css';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	let { cardsOnly = false, announce = true }: { cardsOnly?: boolean; announce?: boolean } =
		$props();
</script>

{#if announce}<span role="status" class="sr-only">Loading contracts</span>{/if}
{#snippet cards()}
	<div class="contract-card-grid" aria-hidden="true">
		{#each Array.from({ length: 12 }) as _, index (index)}
			<div class="min-h-24 rounded-xl border-hairline border-edge bg-surface px-3.5 py-3 pr-10.5 shadow-card">
				<SkeletonBlock class="mb-2 h-[19px] w-3/4" />
				<div class="mb-2 flex items-center gap-1.5">
					<SkeletonBlock class="size-5 rounded-full" />
					<SkeletonBlock class="h-[13px] w-1/3" />
				</div>
				<SkeletonBlock class="h-[13px] w-1/2" />
			</div>
		{/each}
	</div>
{/snippet}

{#if cardsOnly}
	{@render cards()}
{:else}
	<div
		class="min-h-[calc(100dvh-var(--app-header-height))] bg-page px-3 py-4 sm:px-4 md:px-5 md:py-5"
		aria-hidden="true"
	>
		<div class="mx-auto max-w-[1800px]">
			<div class="mb-6 flex items-center gap-2">
				<div
					class="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-button-lg border-hairline border-edge bg-surface px-3 shadow-control"
				>
					<SkeletonBlock class="size-4 rounded-full" />
					<SkeletonBlock class="h-[13px] w-48 max-w-[70%]" />
				</div>
				<SkeletonBlock class="h-[38px] w-[99px] shrink-0 rounded-button-lg" />
			</div>
			<div class="mb-3 text-sm font-medium">Contracts</div>
			{@render cards()}
		</div>
	</div>
{/if}
