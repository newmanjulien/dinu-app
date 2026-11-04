<script lang="ts">
	import '$lib/styles/document-workspace-geometry.css';
	import type { Snippet } from 'svelte';
	import { PAGE_FORMAT } from '$lib/document/pagination/page-format';
	import {
		RAIL_SAFE_GUTTER,
		PANEL_MIN_WIDTH,
		PANEL_COMFORTABLE_WIDTH,
		PANEL_GAP,
		RIGHT_GUTTER
	} from './workspace-layout';

	let {
		reviewGutter = 0,
		hasPanel = false,
		onPageResize,
		children
	}: {
		reviewGutter?: number;
		hasPanel?: boolean;
		onPageResize?: (width: number) => void;
		children: Snippet;
	} = $props();

	function measurePage(node: HTMLDivElement) {
		const update = (width: number) => {
			if (width > 0) onPageResize?.(width);
		};
		update(node.getBoundingClientRect().width);
		const observer = new ResizeObserver(([entry]) => {
			update(entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width);
		});
		observer.observe(node);
		return { destroy: () => observer.disconnect() };
	}
</script>

<div class="w-full @container">
	<div
		class="document-workspace-geometry relative w-full"
		class:has-panel={hasPanel}
		style:--paper-max-width={`${PAGE_FORMAT.width}px`}
		style:--paper-min-width={`${reviewGutter ? 120 : 280}px`}
		style:--review-gutter-max={`${reviewGutter}px`}
		style:--rail-safe-gutter={`${RAIL_SAFE_GUTTER}px`}
		style:--panel-min-width-floor={`${PANEL_MIN_WIDTH}px`}
		style:--panel-comfortable-width={`${PANEL_COMFORTABLE_WIDTH}px`}
		style:--panel-gap={`${PANEL_GAP}px`}
		style:--right-gutter={`${RIGHT_GUTTER}px`}
	>
		{#if onPageResize}
			<!-- Measure even while the document content is hidden or has not mounted. -->
			<div class="page-width-probe" use:measurePage aria-hidden="true"></div>
		{/if}
		{@render children()}
	</div>
</div>

<style>
	.page-width-probe {
		position: absolute;
		width: var(--paper-width);
		height: 0;
		visibility: hidden;
		pointer-events: none;
	}
</style>
