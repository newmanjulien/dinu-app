<script lang="ts">
	import type { Snippet } from 'svelte';
	import DocumentPageFrame from './DocumentPageFrame.svelte';
	import DocumentPaperSkeleton from './DocumentPaperSkeleton.svelte';
	import DocumentPanelSkeleton from './DocumentPanelSkeleton.svelte';
	import DocumentPanelRail from './DocumentPanelRail.svelte';
	import { protectedInteraction } from '$lib/components/ui/interactions';
	const protect = protectedInteraction();

	let {
		hasPanel,
		loading = false,
		placeholderPages = 1,
		placeholderGap = 0,
		interactive = true,
		followScroll = false,
		documentHeight,
		panelTop,
		panelPositionChange = 0,
		layoutElement = $bindable(),
		documentStageElement = $bindable(),
		documentContent,
		panelContent,
		footerContent
	}: {
		hasPanel: boolean;
		loading?: boolean;
		placeholderPages?: number;
		placeholderGap?: number;
		interactive?: boolean;
		followScroll?: boolean;
		documentHeight: number;
		panelTop?: number;
		panelPositionChange?: number;
		layoutElement?: HTMLDivElement | null;
		documentStageElement?: HTMLDivElement | null;
		documentContent: Snippet;
		panelContent: Snippet;
		footerContent?: Snippet;
	} = $props();
	const panelResolved = $derived(panelTop !== undefined);
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
			use:protect={interactive && hasPanel}
			role="region"
			aria-label="Document document"
			class="document-stage relative w-full focus:outline-none"
			bind:this={documentStageElement}
			tabindex={interactive ? -1 : undefined}
			style:height={documentHeight ? `${documentHeight}px` : undefined}
		>
			{#if loading}<div class="flex flex-col" style:gap={`${placeholderGap}px`}>
					{#each Array(placeholderPages) as _}<DocumentPaperSkeleton announce={false} />{/each}
				</div>{/if}<div hidden={loading}>{@render documentContent()}</div>
		</div>
	</DocumentPageFrame>

	{#if hasPanel && loading && !panelResolved}<DocumentPanelSkeleton />
	{:else if hasPanel && panelResolved}
		<DocumentPanelRail
			top={panelTop}
			{followScroll}
			animatePosition={animatePanelPosition}
			{interactive}
		>
			{@render panelContent()}
		</DocumentPanelRail>
	{/if}
</div>
