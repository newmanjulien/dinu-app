<script lang="ts">
	import type { AnnotationActivation } from '$lib/document/annotation-anchor';
	import type { StructuralBoundary } from '$lib/contract/source-index';
	import type { AnnotationMembership } from '$lib/playbook/document-overlay';
	import InlineContent from './InlineContent.svelte';
	import StructuralBoundaryAnchor from './StructuralBoundaryAnchor.svelte';
	import { fragmentKey, type PageFragment } from '$lib/document/pagination/types';

	let {
		fragment,
		profileMode = false,
		interactive = true,
		navigationCapable = false,
		selectedAnnotationId,
		canOpenPlaybookItems,
		structuralBoundaries = [],
		structuralBoundaryAnnotations = new Map(),
		onAnnotationSelect
	}: {
		fragment: PageFragment;
		/** Preserve layout markup while suppressing global IDs and interactive semantics. */
		profileMode?: boolean;
		interactive?: boolean;
		navigationCapable?: boolean;
		selectedAnnotationId: string | null;
		canOpenPlaybookItems: boolean;
		/** Metadata only; the page highlighter measures each boundary's adjacent margin. */
		structuralBoundaries?: readonly StructuralBoundary[];
		structuralBoundaryAnnotations?: ReadonlyMap<string, readonly AnnotationMembership[]>;
		onAnnotationSelect: (
			itemId: string,
			annotationId: string,
			activation: AnnotationActivation
		) => void;
	} = $props();
</script>

{#snippet structuralBoundaryElements()}
	{#each structuralBoundaries as boundary (boundary.afterBlockKey)}
		<span
			class="structural-boundary-target"
			data-structural-boundary={boundary.afterBlockKey}
			aria-hidden="true"
		></span>{#if !profileMode}
			<StructuralBoundaryAnchor
				boundary={boundary}
				annotations={structuralBoundaryAnnotations.get(boundary.afterBlockKey) ?? []}
				selected={(structuralBoundaryAnnotations.get(boundary.afterBlockKey) ?? []).some(
					(annotation) => annotation.id === selectedAnnotationId
				)}
				{interactive}
				{navigationCapable}
				{canOpenPlaybookItems}
				{onAnnotationSelect}
			/>
		{/if}
	{/each}
{/snippet}

{#if fragment.type === 'heading'}
	<svelte:element
		this={`h${fragment.level}`}
		id={profileMode ? undefined : fragment.anchor}
		class="contract-block contract-heading"
		class:has-structural-boundary={Boolean(structuralBoundaries.length)}
		data-block-key={fragment.blockKey}
		data-source-fragment-key={fragmentKey(fragment)}
		tabindex={interactive && !profileMode ? -1 : undefined}
	>
		<InlineContent
			{profileMode}
			{interactive}
			{navigationCapable}
			tokens={fragment.tokens}
			{selectedAnnotationId}
			canOpenPlaybookItems={canOpenPlaybookItems && interactive && !profileMode}
			{onAnnotationSelect}
		/>{@render structuralBoundaryElements()}
	</svelte:element>
{:else if fragment.type === 'paragraph'}
	<p
		class="contract-block contract-paragraph"
		class:is-continuation={fragment.isContinuation}
		class:is-final={fragment.isFinal}
		class:has-structural-boundary={Boolean(structuralBoundaries.length)}
		data-block-key={fragment.blockKey}
		data-source-fragment-key={fragmentKey(fragment)}
	>
		<InlineContent
			{profileMode}
			{interactive}
			{navigationCapable}
			tokens={fragment.tokens}
			{selectedAnnotationId}
			canOpenPlaybookItems={canOpenPlaybookItems && interactive && !profileMode}
			{onAnnotationSelect}
		/>{@render structuralBoundaryElements()}
	</p>
{:else}
	<table
		class="contract-block contract-table"
		class:signature-table={fragment.variant === 'signature'}
		data-block-key={fragment.blockKey}
		data-source-fragment-key={fragmentKey(fragment)}
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
							<InlineContent
								{profileMode}
								{interactive}
								{navigationCapable}
								tokens={cell.tokens}
								{selectedAnnotationId}
								canOpenPlaybookItems={canOpenPlaybookItems && interactive && !profileMode}
								{onAnnotationSelect}
							/>
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
							<InlineContent
								{profileMode}
								{interactive}
								{navigationCapable}
								tokens={cell.tokens}
								{selectedAnnotationId}
								canOpenPlaybookItems={canOpenPlaybookItems && interactive && !profileMode}
								{onAnnotationSelect}
							/>
						</td>{/each}</tr
				>
			{/each}
		</tbody>
	</table>
{/if}
