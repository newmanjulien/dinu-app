<script lang="ts">
	import SkeletonBlock from './SkeletonBlock.svelte';
	let { label, kind = 'rows' }: { label: string; kind?: 'rows' | 'form' | 'calendar' } = $props();
</script>

<div aria-busy="true" aria-label={label} class="grid gap-4 py-4">
	<span role="status" class="sr-only">{label}</span>
	<div aria-hidden="true" class={kind === 'calendar' ? 'grid grid-cols-7 gap-2' : 'grid gap-4'}>
		{#each Array(kind === 'calendar' ? 28 : 3) as _, index (index)}
			<SkeletonBlock
				class={kind === 'calendar'
					? 'h-9 rounded-md'
					: kind === 'form'
						? 'h-11 w-full rounded-lg'
						: 'h-16 w-full rounded-lg'}
			/>
		{/each}
	</div>
</div>
