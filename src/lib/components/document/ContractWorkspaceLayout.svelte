<script lang="ts">
	import '$lib/styles/document-workspace-geometry.css';
	import type { Snippet } from 'svelte';
	import { protectedInteraction } from '$lib/components/ui/interactions';
	const protect = protectedInteraction();
	import { RAIL_SAFE_GUTTER, PANEL_MIN_WIDTH, PANEL_GAP, RIGHT_GUTTER } from './workspace-layout';

	let {
		hasPanel,
		interactive = true,
		followScroll = false,
		displayedPageWidth,
		documentHeight,
		panelTop,
		layoutElement = $bindable(),
		documentStageElement = $bindable(),
		documentContent,
		panelContent,
		footerContent
	}: {
		hasPanel: boolean;
		interactive?: boolean;
		followScroll?: boolean;
		displayedPageWidth: number;
		documentHeight: number;
		panelTop: number;
		layoutElement?: HTMLDivElement;
		documentStageElement?: HTMLDivElement;
		documentContent: Snippet;
		panelContent: Snippet;
		footerContent?: Snippet;
	} = $props();
</script>

<div
	class="document-workspace-geometry relative w-full @container"
	bind:this={layoutElement}
	style:--page-width={`${displayedPageWidth}px`}
	style:--panel-top={`${panelTop}px`}
	style:--rail-safe-gutter={`${RAIL_SAFE_GUTTER}px`}
	style:--panel-min-width={`${PANEL_MIN_WIDTH}px`}
	style:--panel-gap={`${PANEL_GAP}px`}
	style:--right-gutter={`${RIGHT_GUTTER}px`}
	style:min-height={`${documentHeight}px`}
>
	<!-- Keep the container threshold in sync with SIDE_PANEL_BREAKPOINT. -->
	<div
		class={`mx-auto ${hasPanel ? '@min-[1150px]:ml-(--page-left) @min-[1150px]:mr-0' : ''}`}
		style:width={`${displayedPageWidth}px`}
	>
		<!-- Programmatic focus only; inert previews have no focus target. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div
			class="document-stage relative focus:outline-none"
			bind:this={documentStageElement}
			tabindex={interactive ? -1 : undefined}
			style:width={`${displayedPageWidth}px`}
			style:height={`${documentHeight}px`}
		>
			{@render documentContent()}
		</div>
		{@render footerContent?.()}
	</div>

	{#if hasPanel}
		<div
			class="panel-rail pointer-events-none absolute top-(--panel-top) right-(--panel-gap) z-5 w-(--panel-width) animate-[panel-in_140ms_ease_both] @min-[1150px]:right-auto @min-[1150px]:left-[calc(var(--page-left)+var(--page-width)+var(--panel-gap))] @max-[1150px]:fixed @max-[1150px]:inset-x-0 @max-[1150px]:top-auto @max-[1150px]:bottom-0 @max-[1150px]:z-30 @max-[1150px]:w-auto @max-[1150px]:animate-[sheet-in_140ms_ease_both] motion-reduce:animate-none"
			class:follow-scroll={followScroll}
			data-workspace-panel-rail
		>
			<div
				use:protect={interactive}
				class="workspace-panel pointer-events-auto"
				data-workspace-panel
			>
				{@render panelContent()}
			</div>
		</div>
	{/if}
</div>

<style>
	@container (min-width: 1150px) {
		.panel-rail.follow-scroll {
			bottom: 0;
		}

		.follow-scroll > .workspace-panel {
			position: sticky;
			top: calc(var(--app-header-height) + var(--document-viewport-gap));
		}

		.follow-scroll > .workspace-panel > :global(aside) {
			max-height: calc(100dvh - var(--app-header-height) - 2 * var(--document-viewport-gap));
			overflow-y: auto;
			overscroll-behavior: contain;
		}
	}

	@keyframes -global-panel-in {
		from {
			opacity: 0;
			transform: translateY(3px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@keyframes -global-sheet-in {
		from {
			opacity: 0;
			transform: translateY(16px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
