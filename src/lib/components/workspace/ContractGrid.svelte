<script module lang="ts">
	export function contractGridColumns(width: number) {
		return Math.max(1, Math.min(6, Math.floor(width / 300)));
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
</script>

<div
	class="grid grid-cols-1 gap-3 @[600px]:grid-cols-2 @[900px]:grid-cols-3 @[1200px]:grid-cols-4 @[1500px]:grid-cols-5 @[1800px]:grid-cols-6"
>
	{@render children()}
</div>
