<script lang="ts">
	import type { Role } from '../../../convex/permissions';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	import IntegrationAccessSkeleton from './IntegrationAccessSkeleton.svelte';
	import { integrations, integrationActionLabels } from '$lib/integrations';
	let { role }: { role?: Role } = $props();
</script>

<div
	class="min-h-[calc(100dvh-var(--app-header-height))] w-full bg-page px-4 pt-8 pb-4 sm:px-6 md:px-8 md:pt-10 md:pb-6"
	aria-hidden="true"
>
	<div class="mx-auto flex w-full max-w-[61.6rem] flex-col gap-6 pb-10 md:gap-7 md:pb-16">
		{#if role && role !== 'admin'}
			<IntegrationAccessSkeleton />
		{:else}
			<SkeletonBlock class="w-fit text-lg font-medium">Integrations</SkeletonBlock>
		{/if}
		{#if role === 'admin'}
			<SkeletonBlock class="h-[35px] w-full rounded-button-lg border-hairline border-edge" />
			<div class="overflow-hidden rounded-xl border-hairline border-edge">
				{#each integrations as integration, index (integration.slug)}
					<div
						class="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-[11px] gap-y-3 border-edge/50 px-2 py-[9px] sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center sm:gap-x-[15px] sm:px-3"
						class:border-t={index > 0}
					>
						<SkeletonBlock class="size-10 rounded-full" />
						<div class="min-w-0">
							<SkeletonBlock class="w-fit text-[13px] font-medium">{integration.name}</SkeletonBlock
							>
							<SkeletonBlock class="mt-[5px] w-fit text-xs leading-5"
								>{integration.summary}</SkeletonBlock
							>
						</div>
						<SkeletonBlock
							class="col-start-2 h-8 justify-self-start whitespace-nowrap rounded-[7px] border-hairline border-transparent px-[9.5px] py-[3.5px] text-xs font-normal sm:col-start-auto sm:justify-self-end"
						>
							{integrationActionLabels[
								integration.content.kind === 'comingSoon' ? 'comingSoon' : 'available'
							]}
						</SkeletonBlock>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>
