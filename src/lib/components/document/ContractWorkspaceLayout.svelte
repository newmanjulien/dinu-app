<script lang="ts">
	import type { Snippet } from 'svelte';
	import DocumentPageFrame from './DocumentPageFrame.svelte';
	import DocumentPaperSkeleton from './DocumentPaperSkeleton.svelte';
	import DocumentPanelSkeleton from './DocumentPanelSkeleton.svelte';
	import { protectedInteraction } from '$lib/components/ui/interactions';
	const protect = protectedInteraction();

	let {
		hasPanel,
		loading = false,
		interactive = true,
		followScroll = false,
		documentHeight,
		panelTop,
		layoutElement = $bindable(),
		documentStageElement = $bindable(),
		documentContent,
		panelContent,
		footerContent
	}: {
		hasPanel: boolean;
		loading?: boolean;
		interactive?: boolean;
		followScroll?: boolean;
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
	class="relative w-full"
	bind:this={layoutElement}
	style:--panel-top={`${panelTop}px`}
	style:min-height={`${documentHeight}px`}
>
	{#snippet footer()}{#if !loading}{@render footerContent?.()}{/if}{/snippet}
	<DocumentPageFrame {footer}>
		<!-- Programmatic focus only; inert previews have no focus target. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div
			class="document-stage relative w-full focus:outline-none"
			bind:this={documentStageElement}
			tabindex={interactive ? -1 : undefined}
			style:height={documentHeight ? `${documentHeight}px` : undefined}
		>
			{#if loading}<DocumentPaperSkeleton />{/if}
			<div hidden={loading}>{@render documentContent()}</div>
		</div>
	</DocumentPageFrame>

	{#if hasPanel && loading}<DocumentPanelSkeleton />
	{:else if hasPanel}
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
