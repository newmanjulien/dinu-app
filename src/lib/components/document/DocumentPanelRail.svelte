<script lang="ts">
	import type { Snippet } from 'svelte';
	import { protectedInteraction } from '$lib/components/ui/interactions';
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
</script>

<div
	class={`pointer-events-none absolute top-(--panel-top) left-[calc(var(--page-left)+var(--page-width)+var(--panel-gap))] z-5 w-(--panel-width) animate-[panel-in_140ms_ease_both] motion-reduce:animate-none ${followScroll ? 'bottom-0' : ''} ${animatePosition ? 'motion-safe:transition-[top] motion-safe:duration-180 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]' : ''}`}
	bind:this={element}
	class:hidden={!active}
	aria-hidden={pending ? true : undefined}
	inert={pending}
	aria-label={label}
	style:--panel-top={`${top}px`}
	style:height={height === undefined ? undefined : `${height}px`}
>
	<div
		use:protect={interactive && active}
		class={`pointer-events-auto ${followScroll ? 'sticky top-(--document-viewport-gap)' : ''}`}
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
