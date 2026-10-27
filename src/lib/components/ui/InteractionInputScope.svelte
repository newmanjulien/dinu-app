<script lang="ts">
	import type { Snippet } from 'svelte';
	import { setInteractionInputCapture } from './interactions';
	let { capture, children }: { capture: (event: Event) => void; children: Snippet } = $props();
	setInteractionInputCapture((event) => capture(event));
</script>

{@render children()}
