<script lang="ts">
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
</script>

<div aria-hidden="true" class="py-5">
	<SkeletonBlock class="w-fit text-base font-medium"
		>Integrations are available to admins</SkeletonBlock
	>
	<SkeletonBlock class="mt-2 mb-4 w-fit text-sm"
		>Ask a workspace admin about integrations.</SkeletonBlock
	>
	<SkeletonBlock
		class="h-button-sm w-fit whitespace-nowrap rounded-button-lg border-hairline border-transparent px-[13px] py-[7.5px] text-[12.5px] font-normal"
		>Back to Contracts</SkeletonBlock
	>
</div>
