<script lang="ts">
	import type { Snippet } from 'svelte';
	import { protectedInteraction } from '$lib/components/ui/interactions';
	import { getDocumentViewportMetrics } from '$lib/document/document-viewport';
	const protect = protectedInteraction();
	let {
		top = 0,
		height,
		followScroll = false,
		animatePosition = false,
		interactive = true,
		active = true,
		pending = false,
		element = $bindable(),
		label,
		children
	}: {
		top?: number;
		height?: number;
		followScroll?: boolean;
		animatePosition?: boolean;
		interactive?: boolean;
		active?: boolean;
		pending?: boolean;
		element?: HTMLDivElement;
		label?: string;
		children: Snippet;
	} = $props();

	let panelElement = $state<HTMLDivElement>();
	let stickyActive = $state(false);
	let stickyTop = $state<number | null>(null);
	let stickyBottom = $state<number | null>(null);
	const following = $derived(followScroll && stickyActive);

	// Measure once when followScroll starts so sticky never jumps the card under the pointer
	// if it already extends past the viewport top or bottom; ratchet to the normal gap on scroll.
	$effect(() => {
		if (!followScroll || !active) {
			stickyActive = false;
			stickyTop = null;
			stickyBottom = null;
			return;
		}
		const panel = panelElement;
		if (!panel) return;
		const viewport = getDocumentViewportMetrics(panel);
		const gap = viewport.gap;
		if (!viewport.scroller) {
			stickyTop = gap;
			stickyBottom = gap;
			stickyActive = true;
			return;
		}
		const scroller = viewport.scroller;
		const rect = panel.getBoundingClientRect();
		let topInset = Math.min(gap, rect.top - (viewport.top - gap));
		let bottomInset = Math.min(gap, viewport.bottom + gap - rect.bottom);
		stickyTop = topInset;
		stickyBottom = bottomInset;
		stickyActive = true;
		if (topInset >= gap && bottomInset >= gap) return;
		const tighten = () => {
			const current = getDocumentViewportMetrics(panel);
			const box = panel.getBoundingClientRect();
			if (topInset < current.gap) {
				topInset = Math.min(current.gap, Math.max(topInset, box.top - (current.top - current.gap)));
				stickyTop = topInset;
			}
			if (bottomInset < current.gap) {
				bottomInset = Math.min(
					current.gap,
					Math.max(bottomInset, current.bottom + current.gap - box.bottom)
				);
				stickyBottom = bottomInset;
			}
			if (topInset >= current.gap && bottomInset >= current.gap)
				scroller.removeEventListener('scroll', tighten);
		};
		scroller.addEventListener('scroll', tighten, { passive: true });
		return () => scroller.removeEventListener('scroll', tighten);
	});
</script>

<!-- Following spans at least the whole document so the sticky card tracks the viewport in both
     directions without clipping clauses near the end; the spacer preserves the starting anchor. -->
<div
	class={`pointer-events-none absolute left-[calc(var(--page-left)+var(--page-width)+var(--panel-gap))] z-5 w-(--panel-width) animate-[panel-in_140ms_ease_both] motion-reduce:animate-none ${following ? 'top-0 min-h-full' : 'top-(--panel-top)'} ${animatePosition && !following ? 'motion-safe:transition-[top] motion-safe:duration-180 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]' : ''}`}
	bind:this={element}
	class:hidden={!active}
	aria-hidden={pending ? true : undefined}
	inert={pending}
	aria-label={label}
	style:--panel-top={`${top}px`}
	style:height={height === undefined || following ? undefined : `${height}px`}
>
	{#if following}<div aria-hidden="true" class="h-(--panel-top)"></div>{/if}
	<div
		bind:this={panelElement}
		use:protect={interactive && active}
		class={`pointer-events-auto ${following ? 'sticky' : ''}`}
		style:top={following && stickyTop !== null ? `${stickyTop}px` : undefined}
		style:bottom={following && stickyBottom !== null ? `${stickyBottom}px` : undefined}
		data-workspace-panel
	>
		{@render children()}
	</div>
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
</style>
