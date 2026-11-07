<script lang="ts">
	import RevisionText from './RevisionText.svelte';
	import { fragmentKey, type PageFragment } from '$lib/document/pagination/types';

	let {
		fragment,
		collapsed = false,
		profileMode = false,
		interactive = true
	}: {
		fragment: PageFragment;
		collapsed?: boolean;
		/** Preserve layout markup while suppressing global IDs and interactive semantics. */
		profileMode?: boolean;
		interactive?: boolean;
	} = $props();
	const tokenIndices = $derived(
		!profileMode && fragment.type === 'paragraph'
			? new Map(fragment.tokens.map((token, i) => [token, (fragment.interval?.start ?? 0) + i]))
			: undefined
	);
</script>

{#if fragment.type === 'paragraph'}
	<svelte:element
		this={fragment.role === 'title' ? 'h1' : fragment.role === 'heading' ? 'h2' : 'p'}
		id={profileMode || fragment.interval?.start ? undefined : fragment.anchor}
		class="contract-block scroll-mt-[calc(var(--app-header-height)+var(--document-viewport-gap))] focus:outline-none"
		class:contract-heading={fragment.role !== 'body'}
		class:contract-paragraph={fragment.role === 'body'}
		class:is-title={fragment.role === 'title'}
		class:is-final={fragment.isFinal}
		data-block-key={fragment.blockKey}
		data-selection-collapsed={collapsed ? '' : undefined}
		data-source-fragment-key={fragmentKey(fragment)}
		style:--document-block-margin-before={`${fragment.interval?.start ? 0 : (fragment.gapBefore ?? 0)}px`}
		tabindex={interactive && !profileMode && fragment.anchor && !fragment.interval?.start
			? -1
			: undefined}
	>
		<RevisionText {profileMode} tokens={fragment.tokens} {tokenIndices} />
	</svelte:element>
{:else}
	<table
		class="contract-block contract-table"
		class:is-final={fragment.isFinal}
		class:signature-table={fragment.variant === 'signature'}
		data-block-key={fragment.blockKey}
		data-selection-collapsed={collapsed ? '' : undefined}
		data-source-fragment-key={fragmentKey(fragment)}
		style:--document-block-margin-before={`${fragment.interval?.start ? 0 : (fragment.gapBefore ?? 0)}px`}
		style:table-layout={fragment.columnWidths ? 'fixed' : undefined}
	>
		{#if fragment.columnWidths}
			<colgroup>
				{#each fragment.columnWidths as width}<col style:width={`${width}px`} />{/each}
			</colgroup>
		{/if}
		<thead>
			{#each fragment.rows.slice(0, fragment.headerRowCount) as row, rowIndex}
				<tr
					>{#each row as cell, cellIndex}
						<th scope="col" data-source-row={rowIndex} data-source-cell={cellIndex}>
							{#each cell.tokens as token}{#if token.lineAnchor}<span
										class="select-none"
										aria-hidden="true"
										data-selection-line-anchor>{token.value}</span
									>{:else}{token.value}{/if}{/each}
						</th>{/each}</tr
				>
			{/each}
		</thead>
		<tbody>
			{#each fragment.rows.slice(fragment.headerRowCount) as row, rowIndex}
				<tr
					>{#each row as cell, cellIndex}
						<td
							data-source-row={(fragment.interval?.start ?? 0) + rowIndex + fragment.headerRowCount}
							data-source-cell={cellIndex}
						>
							{#each cell.tokens as token}{#if token.lineAnchor}<span
										class="select-none"
										aria-hidden="true"
										data-selection-line-anchor>{token.value}</span
									>{:else}{token.value}{/if}{/each}
						</td>{/each}</tr
				>
			{/each}
		</tbody>
	</table>
{/if}
