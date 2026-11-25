<script lang="ts">
	import type { Snippet } from 'svelte';
	import ProgressDots from '$lib/ui/ProgressDots.svelte';
	let {
		showProgress = true,
		children,
		footer
	}: {
		showProgress?: boolean;
		children: Snippet;
		footer?: Snippet;
	} = $props();
</script>

{#if showProgress}<ProgressDots step={3} />{/if}
<div class="m-auto w-full max-w-190 pt-7 pb-15 text-center">
	{@render children()}
</div>
{#if footer}
	<footer class="translate-y-2 text-center text-xs leading-5 text-ink-muted">
		{@render footer()}
	</footer>
{/if}
