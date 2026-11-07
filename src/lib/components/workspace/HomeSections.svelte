<script lang="ts">
	import type { Snippet } from 'svelte';
	let { sidebar, children }: { sidebar?: Snippet; children: Snippet } = $props();
</script>

<div
	class={sidebar
		? 'grid grid-cols-1 items-start gap-6 min-[1000px]:grid-cols-[450px_minmax(0,1fr)]'
		: ''}
>
	{#if sidebar}
		{@render sidebar()}
	{/if}
	<div class={sidebar ? 'min-w-0 @container' : 'min-w-0'}>
		{@render children()}
	</div>
</div>
