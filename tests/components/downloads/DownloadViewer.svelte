<script lang="ts">
	import type { Snippet } from 'svelte';
	let { footerContent }: { footerContent: Snippet; [key: string]: unknown } = $props();
</script>

{@render footerContent()}
