<script lang="ts">
	import type { Snippet } from 'svelte';
	let { children }: { children?: Snippet; requiresBaseline?: boolean } = $props();
</script>

{@render children?.()}
