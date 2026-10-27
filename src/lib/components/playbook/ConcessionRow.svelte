<script lang="ts">
	import type { Snippet } from 'svelte';
	import PlaybookText from './PlaybookText.svelte';
	let {
		description,
		detail = [],
		after,
		descriptionId,
		children
	}: {
		description: string;
		detail?: readonly string[];
		after?: string;
		descriptionId: string;
		children: Snippet;
	} = $props();
</script>

<p class="m-0">
	<span class="whitespace-pre-wrap" id={descriptionId}>{description}</span>{' '}
	{@render children()}
</p>

{#each detail as text}<PlaybookText {text} />{/each}
{#if after !== undefined}<PlaybookText text={after} />{/if}
