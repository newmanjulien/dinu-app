<script lang="ts">
	import type { Snippet } from 'svelte';
	let { children, footer }: { children: Snippet; footer?: Snippet } = $props();
</script>

<div class="document-workspace-page">
	<div class="document-workspace-paper">{@render children()}</div>
	{@render footer?.()}
</div>
