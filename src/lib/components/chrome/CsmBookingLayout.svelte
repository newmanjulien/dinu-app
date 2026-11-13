<script lang="ts">
	import type { Snippet } from 'svelte';
	let {
		description,
		headingId,
		loading = false,
		duration,
		children
	}: {
		description: string;
		headingId: string;
		loading?: boolean;
		duration?: Snippet;
		children: Snippet;
	} = $props();
</script>

<section aria-labelledby={headingId} aria-busy={loading} class="booking mt-8 @container">
	<div class="flex items-center justify-between gap-3">
		<h3 id={headingId} class="text-[13px] text-ink-muted">
			{description}
		</h3>
		{@render duration?.()}
	</div>
	{@render children()}
</section>
