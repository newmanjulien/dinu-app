<script lang="ts">
	import type { Snippet } from 'svelte';
	let { children, footer }: { children: Snippet; footer?: Snippet } = $props();
</script>

<div class="ml-(--page-margin-left) mr-(--page-margin-right) w-(--page-width)">
	<div class="ml-(--review-gutter) w-(--paper-width)">{@render children()}</div>
	{@render footer?.()}
</div>
