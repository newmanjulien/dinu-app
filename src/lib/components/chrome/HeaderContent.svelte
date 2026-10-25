<script lang="ts">
	import type { Snippet } from 'svelte';
	import { getHeaderContent } from './header-content.svelte';
	let { children }: { children: Snippet } = $props();
	const header = getHeaderContent();
	$effect(() => header.register(children));
</script>
