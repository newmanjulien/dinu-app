<script lang="ts">
	import '$lib/styles/document-workspace-geometry.css';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	import { PAGE_FORMAT } from '$lib/document/pagination/page-format';
	import {
		SIDE_PANEL_RESERVED_WIDTH,
		RAIL_SAFE_GUTTER,
		PANEL_MIN_WIDTH,
		PANEL_GAP,
		RIGHT_GUTTER
	} from './workspace-layout';
	let {
		admin = false,
		embedded = false,
		chrome = !embedded,
		hasPanel = false,
		label = 'Loading contract',
		announce = true
	}: {
		admin?: boolean;
		embedded?: boolean;
		chrome?: boolean;
		hasPanel?: boolean;
		label?: string;
		announce?: boolean;
	} = $props();
</script>

{#if announce}<span role="status" class="sr-only">{label}</span>{/if}
<div class="document-skeleton" class:embedded class:admin aria-hidden="true">
	{#if chrome}
		<div
			class="pointer-events-none fixed top-[calc(var(--app-header-height)+8px)] left-2 flex gap-1 rounded-lg border border-line bg-surface p-1 min-[1000px]:top-[calc(var(--app-header-height)+20px)] min-[1000px]:flex-col min-[1000px]:gap-5 min-[1000px]:border-0"
		>
			<SkeletonBlock class="size-7 rounded-button-sm" />
			<SkeletonBlock class="size-7 rounded-button-sm" />
		</div>
	{/if}
	{#if admin && !embedded}
		<div class="mb-5 px-2 text-center text-[13px] leading-6 text-ink-muted/50">
			Edit the instructions reps will see
		</div>
	{/if}
	<div
		class="page-layout document-workspace-geometry @container"
		class:has-panel={hasPanel}
		style:--paper-width={`${PAGE_FORMAT.width}px`}
		style:--paper-ratio={`${PAGE_FORMAT.width} / ${PAGE_FORMAT.height}`}
		style:--paper-padding={`${(PAGE_FORMAT.horizontalPadding / PAGE_FORMAT.width) * 100}%`}
		style:--paper-top-padding={`${(PAGE_FORMAT.firstTopPadding / PAGE_FORMAT.width) * 100}%`}
		style:--reserved-width={`${SIDE_PANEL_RESERVED_WIDTH}px`}
		style:--rail-safe-gutter={`${RAIL_SAFE_GUTTER}px`}
		style:--panel-min-width={`${PANEL_MIN_WIDTH}px`}
		style:--panel-gap={`${PANEL_GAP}px`}
		style:--right-gutter={`${RIGHT_GUTTER}px`}
	>
		<div class="paper">
			<div class="paper-content">
				<SkeletonBlock class="mx-auto mb-10 h-5 w-1/2" />
				{#each [0, 1, 2, 3] as paragraph (paragraph)}
					<div class="mb-8 space-y-3">
						<SkeletonBlock class="mb-4 h-3.5 w-1/3" />
						<SkeletonBlock class="h-2.5 w-full" />
						<SkeletonBlock class="h-2.5 w-[95%]" />
						<SkeletonBlock class="h-2.5 w-full" />
						<SkeletonBlock class="h-2.5 w-3/4" />
					</div>
				{/each}
			</div>
		</div>
		{#if hasPanel}
			<div class="panel hidden rounded-xl border border-line bg-surface p-5 @min-[1150px]:block">
				<SkeletonBlock class="mb-6 h-4 w-2/3" />
				<SkeletonBlock class="mb-3 w-full" />
				<SkeletonBlock class="mb-6 w-3/4" />
				<SkeletonBlock class="h-24 w-full" />
			</div>
		{/if}
	</div>
</div>

<style>
	.document-skeleton {
		padding-block: 56px 64px;
	}
	.document-skeleton.admin {
		padding-bottom: 48px;
	}
	.document-skeleton.embedded {
		padding: 0;
	}
	.page-layout {
		position: relative;
		width: 100%;
		--page-width: min(var(--paper-width), max(280px, calc(100cqw - var(--reserved-width))));
	}
	.paper {
		width: min(var(--paper-width), max(280px, calc(100cqw - 30px)));
		aspect-ratio: var(--paper-ratio);
		margin-inline: auto;
		overflow: hidden;
		outline: 1px solid var(--color-line);
		outline-offset: -1px;
		background: var(--color-surface);
	}
	.paper-content {
		padding: var(--paper-top-padding) var(--paper-padding);
	}
	@media (min-width: 1000px) {
		.document-skeleton:not(.embedded) {
			padding-top: 24px;
		}
	}
	@container (min-width: 1150px) {
		.paper {
			width: min(var(--paper-width), max(280px, calc(100cqw - var(--reserved-width))));
		}
		.has-panel .paper {
			margin-left: var(--page-left);
			margin-right: 0;
		}
		.panel {
			position: absolute;
			top: 0;
			left: calc(var(--page-left) + var(--page-width) + var(--panel-gap));
			width: var(--panel-width);
		}
	}
</style>
