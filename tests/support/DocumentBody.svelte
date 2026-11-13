<script lang="ts">
	import type { Snippet } from 'svelte';
	let { children }: { children?: Snippet; requiresTemplate?: boolean } = $props();
</script>

{@render children?.()}
