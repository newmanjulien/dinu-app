<script lang="ts">
	import type { InlineToken } from '$lib/document/pagination/types';
	import { groupRevisionRuns } from '$lib/document/revision-runs';
	import SourceText from './SourceText.svelte';
	let {
		tokens,
		profileMode = false,
		tokenIndices
	}: {
		tokens: readonly InlineToken[];
		profileMode?: boolean;
		tokenIndices?: ReadonlyMap<InlineToken, number>;
	} = $props();
	let runs = $derived(groupRevisionRuns(tokens));
</script>

{#each runs as run}
	{#if run.revision === 'removed'}
		<del class="select-none line-through"
			><SourceText tokens={run.tokens} {profileMode} {tokenIndices} /></del
		>
	{:else if run.revision === 'added'}
		<ins class="no-underline"><SourceText tokens={run.tokens} {profileMode} {tokenIndices} /></ins>
	{:else}
		<SourceText tokens={run.tokens} {profileMode} {tokenIndices} />
	{/if}
{/each}
