<script lang="ts">
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
</script>

<section aria-label="Integrations" class="min-w-0">
	<h2 class="mb-3 text-[13.5px] font-medium">Integrations</h2>
	<span role="status" class="sr-only">Loading integrations</span>
	<div
		class="overflow-hidden rounded-xl border-hairline border-edge bg-surface shadow-card"
		aria-hidden="true"
	>
		{#each [0, 1, 2] as index (index)}
			<div class="flex items-center gap-3 border-edge/50 px-3.5 py-3" class:border-t={index > 0}>
				<SkeletonBlock class="size-9 shrink-0 rounded-full" />
				<div class="min-w-0 flex-1">
					<SkeletonBlock class="h-5 w-24" />
					<SkeletonBlock class="mt-1.5 h-4 w-4/5" />
				</div>
			</div>
		{/each}
	</div>
</section>
