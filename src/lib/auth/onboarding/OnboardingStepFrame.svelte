<script lang="ts">
	import type { Snippet } from 'svelte';

	let { title, description, children }: { title: string; description?: string; children: Snippet } =
		$props();
</script>

<h1 class="m-0 text-[26px] font-[450] leading-[1.08] tracking-[-0.02em] text-ink">
	{title}
</h1>
{#if description}
	<p class="mx-auto mt-4 text-sm leading-[1.45] text-balance text-ink-muted">
		{description}
	</p>
{/if}

<div class="mt-10">
	{@render children()}
</div>
