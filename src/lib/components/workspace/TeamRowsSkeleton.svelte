<script lang="ts">
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	let { invitations = false }: { invitations?: boolean } = $props();
</script>

<div
	class="divide-y-[length:var(--surface-border-width)] divide-line rounded-xl border-hairline border-edge bg-surface shadow-card"
	aria-hidden="true"
>
	{#each Array.from({ length: invitations ? 3 : 4 }) as _, index (index)}
		<div class="flex min-h-[68px] items-center gap-3 p-4">
			{#if !invitations}<SkeletonBlock class="size-7 shrink-0 rounded-full" />{/if}
			<div class="min-w-0 flex-1 space-y-2">
				<SkeletonBlock class="h-[17px] w-40 max-w-[70%]" />
				<SkeletonBlock class="h-[13px] w-52 max-w-[85%]" />
			</div>
			<SkeletonBlock class="h-[15px] w-8 shrink-0" />
		</div>
	{/each}
</div>
