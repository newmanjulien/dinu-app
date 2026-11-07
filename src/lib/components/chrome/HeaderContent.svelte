<script lang="ts">
	import type { Snippet } from 'svelte';
	import { getHeaderContent } from './header-content.svelte';
	let { children, placement = 'overlay' }: { children: Snippet; placement?: 'overlay' | 'notice' } =
		$props();
	const header = getHeaderContent();
	$effect(() => header.register(children, placement));
</script>
