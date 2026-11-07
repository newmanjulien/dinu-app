<script lang="ts">
	import { env } from '$env/dynamic/public';
	import { isTextTarget } from '$lib/contract/source-model';
	import type { InlineToken } from '$lib/document/pagination/types';
	let {
		tokens,
		profileMode = false,
		tokenIndices
	}: {
		tokens: readonly InlineToken[];
		profileMode?: boolean;
		tokenIndices?: ReadonlyMap<InlineToken, number>;
	} = $props();
	function visualRange(token: InlineToken) {
		return token.visualSource && isTextTarget(token.visualSource)
			? token.visualSource.range
			: undefined;
	}
</script>

<!-- Measurement needs the same spans and text, but never reads interaction metadata.
     Set the diagnostic flag to 1 to profile source metadata. -->
{#if profileMode && env.PUBLIC_CONTRACT_PROFILE_METADATA !== '1'}
	{#each tokens as token}<span data-contract-token="" class:select-none={token.lineAnchor}
			>{token.value}</span
		>{/each}
{:else}
	{#each tokens as token}
		{@const source = visualRange(token)}
		<span
			data-contract-token=""
			data-selection-token-index={profileMode ? undefined : tokenIndices?.get(token)}
			data-selection-line-anchor={token.lineAnchor ? '' : undefined}
			aria-hidden={token.lineAnchor ? true : undefined}
			class:select-none={token.lineAnchor}
			data-source-start-key={token.source?.start.sourceKey}
			data-source-start-offset={token.source?.start.offset}
			data-source-end-key={token.source?.end.sourceKey}
			data-source-end-offset={token.source?.end.offset}
			data-visual-source={token.visualSource ? JSON.stringify(token.visualSource) : undefined}
			data-visual-source-start-key={source?.start.sourceKey}
			data-visual-source-start-offset={source?.start.offset}
			data-visual-source-end-key={source?.end.sourceKey}
			data-visual-source-end-offset={source?.end.offset}
			data-generated-offset={token.generatedOffset}
			data-source-kind={token.sourceKind}
			data-generated={token.generated}
			data-revision={token.revision}>{token.value}</span
		>
	{/each}
{/if}
