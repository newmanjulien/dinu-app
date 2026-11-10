<script lang="ts">
	import type { Role } from '../../../convex/permissions';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	import TeamRowsSkeleton from './TeamRowsSkeleton.svelte';
	let { role }: { role?: Role } = $props();
</script>

<div
	class="min-h-[calc(100dvh-var(--app-header-height))] bg-surface px-4 pt-8 pb-8 sm:px-6 md:px-8 md:pt-10"
	aria-hidden="true"
>
	<div class="mx-auto max-w-4xl space-y-8">
		<div class="text-lg font-medium">Manage team</div>
		<div class="flex items-center justify-between gap-4">
			<div class="min-w-0">
				<SkeletonBlock class="h-5 w-40" />
				<SkeletonBlock class="mt-2 w-fit text-sm"
					>Your company is private. Colleagues join by invitation.</SkeletonBlock
				>
			</div>
			{#if role === 'admin'}<SkeletonBlock
					class="h-button-sm shrink-0 whitespace-nowrap rounded-button-lg px-[13px] py-[7.5px] text-[12.5px] font-normal"
					><span class="inline-flex items-center gap-1"
						><span class="size-[15px]"></span>Invite</span
					></SkeletonBlock
				>{/if}
		</div>
		<div>
			<div class="mb-3 text-sm font-medium">Colleagues</div>
			<TeamRowsSkeleton />
		</div>
		{#if role === 'admin'}
			<div>
				<div class="mb-3 text-sm font-medium">Pending invitations</div>
				<TeamRowsSkeleton invitations />
			</div>
		{/if}
		{#if role}
			<div class="border-t-[length:var(--surface-border-width)] border-line pt-6">
				<div class="text-sm font-medium">Leave company</div>
				<SkeletonBlock class="mt-2 h-5 w-full max-w-lg" />
			</div>
		{/if}
	</div>
</div>
