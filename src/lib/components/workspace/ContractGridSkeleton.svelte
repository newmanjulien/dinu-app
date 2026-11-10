<script lang="ts">
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	let { announce = true }: { announce?: boolean } = $props();
</script>

{#if announce}<span role="status" class="sr-only">Loading contracts</span>{/if}
<div class="grid grid-cols-1 gap-3 @[600px]:grid-cols-2 @[1000px]:grid-cols-4" aria-hidden="true">
	{#each Array.from({ length: 16 }) as _, index (index)}
		<div
			class={[
				'relative rounded-xl border-hairline border-edge bg-surface py-[9px] pr-[80px] pl-[11px] shadow-card',
				index >= 8 ? 'hidden @[1000px]:block' : index >= 4 ? 'hidden @[600px]:block' : ''
			]}
		>
			<SkeletonBlock class="mb-1.5 h-5 w-3/4" />
			<div class="flex items-center gap-2">
				<SkeletonBlock class="size-5 rounded-full" />
				<SkeletonBlock class="h-[13px] w-1/3" />
			</div>
			<SkeletonBlock class="mt-1.5 h-4 w-2/3" />
			<div class="absolute top-[9px] right-[11px] inline-flex items-center">
				<SkeletonBlock class="size-6 rounded-full" />
				<SkeletonBlock class="-ml-0.5 h-[18px] w-4 rounded-md" />
			</div>
		</div>
	{/each}
</div>
