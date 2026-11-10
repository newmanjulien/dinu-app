<script lang="ts">
	import type { Snippet } from 'svelte';

	type Props = {
		title: string;
		description?: string | Snippet;
		children: Snippet;
	};

	let { title, description, children }: Props = $props();
</script>

<div class="w-full">
	<h1 class="m-0 text-center text-2xl font-[450] leading-[1.08] tracking-[-0.02em] text-ink">
		{title}
	</h1>
	{#if typeof description === 'function'}
		<div class="mx-auto mt-3.5 max-w-100">{@render description()}</div>
	{:else if description}
		<p class="mx-auto mt-3.5 max-w-100 text-center text-sm leading-[1.45] text-ink-muted">
			{description}
		</p>
	{/if}

	<div class="mt-[clamp(26px,4vh,52px)]">
		{@render children()}
	</div>
</div>
