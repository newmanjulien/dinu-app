<script lang="ts">
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
</script>

<div
	aria-hidden="true"
	class="panel hidden rounded-base border-hairline border-edge bg-surface p-3.5 shadow-card @min-[1150px]:block"
>
	<SkeletonBlock class="mb-6 h-[19px] w-2/3" />
	<SkeletonBlock class="mb-3 w-full" />
	<SkeletonBlock class="mb-6 w-3/4" />
	<SkeletonBlock class="h-24 w-full" />
</div>

<style>
	@container (min-width: 1150px) {
		.panel {
			position: absolute;
			top: 0;
			left: calc(var(--page-left) + var(--page-width) + var(--panel-gap));
			width: var(--panel-width);
		}
	}
</style>
