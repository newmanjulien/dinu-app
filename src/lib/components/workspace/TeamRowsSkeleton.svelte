<script lang="ts">
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	let { invitations = false }: { invitations?: boolean } = $props();
</script>

<div
	class="divide-y-[length:var(--surface-border-width)] divide-line rounded-xl border-hairline border-edge bg-surface shadow-card"
	aria-hidden="true"
>
	{#each Array.from({ length: invitations ? 3 : 4 }) as _, index (index)}
		<div class="flex flex-wrap items-center gap-3 p-3.5">
			{#if !invitations}<SkeletonBlock class="size-7 shrink-0 rounded-full" />{/if}
			<div class="min-w-0 flex-1">
				<SkeletonBlock class="h-5 w-40 max-w-[70%]" />
				<SkeletonBlock class="h-4 w-52 max-w-[85%]" />
			</div>
			{#if invitations}
				{#each ['Resend', 'Revoke'] as label (label)}
					<SkeletonBlock
						class="h-button-sm shrink-0 whitespace-nowrap rounded-button-lg px-[13px] py-[7.5px] text-[12.5px]"
						>{label}</SkeletonBlock
					>
				{/each}
			{:else}
				<SkeletonBlock class="h-4 w-8 shrink-0" />
			{/if}
		</div>
	{/each}
</div>
