<script lang="ts">
	import type { AnnotationActivation } from '$lib/document/annotation-anchor';
	import { PAGE_FORMAT } from '$lib/document/pagination/page-format';
	import type { HighlightRect } from '$lib/document/highlights/geometry';
	import type { AnnotationMembership } from '$lib/playbook/document-overlay';
	import BlockFragment from './BlockFragment.svelte';
	import { fragmentKey, type PaginatedPage } from '$lib/document/pagination/types';

	let {
		page,
		highlights = [],
		interactive = true,
		navigationCapable = false,
		selectedAnnotationId,
		canOpenPlaybookItems,
		onAnnotationSelect,
		structuralBoundaryAnnotations = new Map()
	}: {
		page: PaginatedPage;
		highlights?: readonly HighlightRect[];
		interactive?: boolean;
		navigationCapable?: boolean;
		selectedAnnotationId: string | null;
		canOpenPlaybookItems: boolean;
		onAnnotationSelect: (
			itemId: string,
			annotationId: string,
			activation: AnnotationActivation
		) => void;
		structuralBoundaryAnnotations?: ReadonlyMap<string, readonly AnnotationMembership[]>;
	} = $props();
</script>

<article
	class="document-page"
	class:first-page={page.number === 1}
	aria-label={`Page ${page.number}`}
	data-page-number={page.number}
>
	<div class="document-page__content contract-document contract-flow">
		{#each page.placements as { fragment, structuralBoundaries } (fragmentKey(fragment))}
			<BlockFragment
				{fragment}
				{interactive}
				{navigationCapable}
				{selectedAnnotationId}
				{canOpenPlaybookItems}
				{onAnnotationSelect}
				{structuralBoundaries}
				{structuralBoundaryAnnotations}
			/>
		{/each}
	</div>
	<svg
		class="document-highlights"
		aria-hidden="true"
		viewBox={`0 0 ${PAGE_FORMAT.width} ${PAGE_FORMAT.height}`}
	>
		{#each highlights as rect}
			<rect
				x={rect.x}
				y={rect.y}
				width={rect.width}
				height={rect.height}
				class={`document-highlight document-highlight--${rect.kind}`}
				data-trigger-state={rect.triggerState}
			/>
		{/each}
	</svg>
	<div class="document-page__number" aria-hidden="true">
		{page.number}
	</div>
</article>
