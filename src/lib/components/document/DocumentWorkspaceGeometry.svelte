<script lang="ts">
	import '$lib/styles/document-workspace-geometry.css';
	import type { Snippet } from 'svelte';
	import { PAGE_FORMAT } from '$lib/document/pagination/page-format';
	import { REVIEW_GUTTER_WIDTH, PANEL_WIDTH, PANEL_GAP } from './workspace-layout';

	let {
		reserveReviewGutter = false,
		hasRightRail = false,
		notice,
		children
	}: {
		reserveReviewGutter?: boolean;
		hasRightRail?: boolean;
		notice?: Snippet;
		children: Snippet;
	} = $props();
</script>

<!-- Narrow screens intentionally keep panels beside fixed-width paper; opening one does not auto-scroll horizontally. -->
{@render notice?.()}
<div
	class="document-workspace-geometry relative w-(--workspace-width) pb-[var(--document-section-bottom-padding,64px)]"
	class:has-right-rail={hasRightRail}
	style:--paper-width={`${PAGE_FORMAT.width}px`}
	style:--review-gutter={`${reserveReviewGutter ? REVIEW_GUTTER_WIDTH : 0}px`}
	style:--panel-width={`${PANEL_WIDTH}px`}
	style:--panel-gap={`${PANEL_GAP}px`}
>
	{@render children()}
</div>
