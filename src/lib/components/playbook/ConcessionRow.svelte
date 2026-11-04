<script lang="ts">
	import type { Snippet } from 'svelte';
	let {
		description,
		descriptionId,
		children
	}: {
		description: string;
		descriptionId: string;
		children: Snippet;
	} = $props();
</script>

<p class="m-0">
	<span class="whitespace-pre-wrap" id={descriptionId}>{description}</span>{' '}
	{@render children()}
</p>
