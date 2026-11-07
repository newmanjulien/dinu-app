<script lang="ts">
	import type { Snippet } from 'svelte';
	import DocumentPageFrame from './DocumentPageFrame.svelte';
	import DocumentPaperSkeleton from './DocumentPaperSkeleton.svelte';
	import DocumentPanelSkeleton from './DocumentPanelSkeleton.svelte';
	import { protectedInteraction } from '$lib/components/ui/interactions';
	const protect = protectedInteraction();

	let {
		hasPanel,
		protectDocumentStage = false,
		loading = false,
		interactive = true,
		followScroll = false,
		documentHeight,
		panelTop,
		panelResolved = false,
		panelPositionChange = 0,
		layoutElement = $bindable(),
		documentStageElement = $bindable(),
		documentContent,
		panelContent,
		footerContent
	}: {
		hasPanel: boolean;
		protectDocumentStage?: boolean;
		loading?: boolean;
		interactive?: boolean;
		followScroll?: boolean;
		documentHeight: number;
		panelTop?: number;
		panelResolved?: boolean;
		panelPositionChange?: number;
		layoutElement?: HTMLDivElement;
		documentStageElement?: HTMLDivElement;
		documentContent: Snippet;
		panelContent: Snippet;
		footerContent?: Snippet;
	} = $props();
	let animatePanelPosition = $state(false);
	let handledPanelPositionChange = 0;
	$effect(() => {
		const change = panelPositionChange;
		if (!hasPanel || !panelResolved) {
			animatePanelPosition = false;
			handledPanelPositionChange = change;
			return;
		}
		if (change === handledPanelPositionChange) return;
		handledPanelPositionChange = change;
		animatePanelPosition = true;
		const timeout = setTimeout(() => {
			if (panelPositionChange === change) animatePanelPosition = false;
		}, 180);
		return () => clearTimeout(timeout);
	});
</script>

<div
	class="relative w-full"
	bind:this={layoutElement}
	style:--panel-top={`${panelTop ?? 0}px`}
	style:min-height={`${documentHeight}px`}
>
	{#snippet footer()}{#if !loading}{@render footerContent?.()}{/if}{/snippet}
	<DocumentPageFrame {footer}>
		<!-- Programmatic focus only; inert previews have no focus target. -->
		<!-- Keep the loaded stage free of unowned formatting whitespace. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<!-- prettier-ignore -->
		<div
			use:protect={interactive && protectDocumentStage}
			role="region"
			aria-label="Contract document"
			class="document-stage relative w-full focus:outline-none"
			bind:this={documentStageElement}
			tabindex={interactive ? -1 : undefined}
			style:height={documentHeight ? `${documentHeight}px` : undefined}
		>
			{#if loading}<DocumentPaperSkeleton />{/if}<div hidden={loading}>{@render documentContent()}</div>
		</div>
	</DocumentPageFrame>

	{#if hasPanel && loading}<DocumentPanelSkeleton />
	{:else if hasPanel && panelResolved}
		<div
			class={`pointer-events-none absolute top-(--panel-top) right-(--panel-gap) z-5 w-(--panel-width) animate-[panel-in_140ms_ease_both] @min-[1150px]:right-auto @min-[1150px]:left-[calc(var(--page-left)+var(--page-width)+var(--panel-gap))] @max-[1150px]:fixed @max-[1150px]:inset-x-0 @max-[1150px]:top-auto @max-[1150px]:bottom-0 @max-[1150px]:z-30 @max-[1150px]:w-auto @max-[1150px]:animate-[sheet-in_140ms_ease_both] motion-reduce:animate-none ${followScroll ? '@min-[1150px]:bottom-0' : ''} ${animatePanelPosition ? 'motion-safe:@min-[1150px]:transition-[top] motion-safe:@min-[1150px]:duration-180 motion-safe:@min-[1150px]:ease-[cubic-bezier(0.22,1,0.36,1)]' : ''}`}
			data-workspace-panel-rail
		>
			<div
				use:protect={interactive}
				class={`pointer-events-auto ${followScroll ? '@min-[1150px]:sticky @min-[1150px]:top-[calc(var(--app-header-height)+var(--document-viewport-gap))] @min-[1150px]:[&>aside]:max-h-[calc(100dvh-var(--app-header-height)-2*var(--document-viewport-gap))] @min-[1150px]:[&>aside]:overflow-y-auto @min-[1150px]:[&>aside]:overscroll-contain' : ''}`}
				data-workspace-panel
			>
				{@render panelContent()}
			</div>
		</div>
	{/if}
</div>

<style>
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
