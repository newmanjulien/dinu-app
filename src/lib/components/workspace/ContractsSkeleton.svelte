<script lang="ts">
	import type { Role } from '../../../convex/permissions';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	import ContractGridSkeleton from './ContractGridSkeleton.svelte';
	let { role, announce = true }: { role?: Role; announce?: boolean } = $props();
</script>

{#if announce}<span role="status" class="sr-only">Loading your workspace</span>{/if}
<div
	class="min-h-[calc(100dvh-var(--app-header-height))] bg-page px-4 py-4 sm:px-6 md:px-8 md:py-5"
	aria-hidden="true"
>
	<div class="mx-auto max-w-[1800px]">
		<div class="mb-6 flex items-center gap-2">
			<div
				class="flex h-[35px] min-w-0 flex-1 items-center gap-[7px] rounded-button-lg border-hairline border-edge bg-surface px-[11px] shadow-control"
			>
				<SkeletonBlock class="size-[17px] shrink-0 rounded-full" />
				<SkeletonBlock class="min-w-0 truncate text-[13px] font-[350]"
					>Search by name of company</SkeletonBlock
				>
			</div>
			<SkeletonBlock
				class="flex h-button-sm shrink-0 items-center gap-1 whitespace-nowrap rounded-button-lg px-[13px] py-[7.5px] text-[12.5px] font-normal"
			>
				<span class="inline-flex items-center gap-1"
					><span class="size-[15px]"></span>New contract</span
				>
			</SkeletonBlock>
		</div>
		{#if role}
			<div class="min-w-0 @container">
				<ContractGridSkeleton announce={false} />
			</div>
		{/if}
	</div>
</div>
