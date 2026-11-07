<script lang="ts">
	import type { AnnotationActivation } from '$lib/document/annotation-anchor';
	import { PAGE_FORMAT } from '$lib/document/pagination/page-format';
	import { CONTRACT_STYLE } from '$lib/contract/format';
	import type { HighlightRect } from '$lib/document/highlights/geometry';
	import type { BoundaryOption } from '$lib/document/selection/boundary-options';
	import type { AnnotationMembership } from '$lib/playbook/document-overlay';
	import { mountSelectionPage } from '$lib/document/selection/selection-surface';
	import StructuralBoundaryControls from './StructuralBoundaryControls.svelte';
	import {
		breakGroupKey,
		type SelectionDocument,
		type BreakOccurrence
	} from '$lib/document/selection/selection-model';
	import BlockFragment from './BlockFragment.svelte';
	import { fragmentKey, type PaginatedPage } from '$lib/document/pagination/types';

	let {
		page,
		selectionDocument,
		highlights = [],
		interactive = true,
		navigationCapable = false,
		selectedAnnotationId,
		canOpenPlaybookItems,
		onAnnotationSelect,
		structuralBoundaryAnnotations = new Map()
	}: {
		page: PaginatedPage;
		selectionDocument?: SelectionDocument;
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
	const groups = $derived(
		selectionDocument?.pages
			.get(page.number)
			?.filter((entry): entry is BreakOccurrence => entry.kind === 'break') ?? []
	);
	function options(entry: BreakOccurrence): BoundaryOption[] {
		// Display-only groups still need an owner for exact saved collapsed-text targets.
		const boundaries = entry.group.boundaries.length
			? entry.group.boundaries
			: [{ afterBlockKey: breakGroupKey(entry.group) }];
		return boundaries.map((boundary) => ({ boundary, label: entry.group.label }));
	}
</script>

{#snippet breakControls(group: BreakOccurrence)}
	<span class="selection-break-owner" data-selection-break-owner={group.order}>
		<StructuralBoundaryControls
			options={options(group)}
			gap={group.gap}
			selectionGroup={group.group.id}
			annotations={structuralBoundaryAnnotations}
			{selectedAnnotationId}
			{interactive}
			{navigationCapable}
			{canOpenPlaybookItems}
			{onAnnotationSelect}
		/>
	</span>
{/snippet}

<!-- Keep these siblings adjacent: formatting whitespace is not contract content. -->
<!-- prettier-ignore -->
<article
	use:mountSelectionPage={{ page, document: selectionDocument }}
	class="document-page relative isolate h-(--contract-page-height) w-(--contract-page-width) overflow-hidden px-(--contract-page-horizontal-padding) pt-(--contract-page-top-padding) pb-(--contract-page-bottom-padding) data-[page-number=1]:pt-(--contract-first-page-top-padding) rounded-none border-0 bg-surface shadow-card outline-(length:--surface-border-width) outline-edge outline-offset-[calc(-1*var(--surface-border-width))]"
	aria-label={`Page ${page.number}`}
	data-page-number={page.number}
>
	<div
		class="document-page__content contract-document flex w-(--contract-content-width) flex-col"
		style={CONTRACT_STYLE}
	>
		{#each page.placements as placement (fragmentKey(placement.fragment))}
			{@const fragment = placement.fragment}
			{#each groups.filter((group) => group.placement === placement && group.edge === 'before') as group (group.edge)}
				{@render breakControls(group)}
			{/each}<BlockFragment
				{fragment}
				collapsed={placement.prepared.flowRole === 'empty'}
				{interactive}
			/>{#each groups.filter((group) => group.placement === placement && group.edge === 'after') as group (group.edge)}
				{@render breakControls(group)}
			{/each}
		{/each}
	</div><svg
		class="document-highlights pointer-events-none absolute inset-0 size-full mix-blend-multiply"
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
	</svg><div
		data-document-chrome
		class="absolute right-12 bottom-8 text-sm leading-none text-ink-muted/65"
		aria-hidden="true"
	>
		{page.number}
	</div>
</article>
