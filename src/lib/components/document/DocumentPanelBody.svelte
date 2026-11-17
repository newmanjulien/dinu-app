<script lang="ts">
	import type { Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
</script>

<div class="flex min-w-0 w-full flex-col gap-3 p-3.5">
	{@render children()}
</div>
