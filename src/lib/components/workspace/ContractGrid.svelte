<script lang="ts">
	import type { Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
</script>

<div class="grid grid-cols-1 gap-3 @[600px]:grid-cols-2 @[1000px]:grid-cols-3">
	{@render children()}
</div>
