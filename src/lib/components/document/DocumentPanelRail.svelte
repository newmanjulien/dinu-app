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
	class={`pointer-events-none absolute top-(--panel-top) right-(--panel-gap) z-5 w-(--panel-width) animate-[panel-in_140ms_ease_both] @min-[1150px]:right-auto @min-[1150px]:left-[calc(var(--page-left)+var(--page-width)+var(--panel-gap))] @max-[1150px]:fixed @max-[1150px]:inset-x-0 @max-[1150px]:top-auto @max-[1150px]:bottom-[var(--buyer-link-bar-height,0px)] @max-[1150px]:z-30 @max-[1150px]:w-auto @max-[1150px]:animate-[sheet-in_140ms_ease_both] @max-[1150px]:h-auto! motion-reduce:animate-none ${followScroll ? '@min-[1150px]:bottom-0' : ''} ${animatePosition ? 'motion-safe:@min-[1150px]:transition-[top] motion-safe:@min-[1150px]:duration-180 motion-safe:@min-[1150px]:ease-[cubic-bezier(0.22,1,0.36,1)]' : ''}`}
	bind:this={element}
	class:hidden={!active}
	class:@max-[1150px]:hidden={pending}
	aria-hidden={pending ? true : undefined}
	inert={pending}
	aria-label={label}
	style:--panel-top={`${top}px`}
	style:height={height === undefined ? undefined : `${height}px`}
	data-workspace-panel-rail
>
	<div
		use:protect={interactive && active}
		class={`pointer-events-auto @max-[1150px]:[&_aside]:max-h-[min(65dvh,calc(100dvh-var(--app-header-height)-var(--buyer-link-bar-height,0px)-24px))] ${followScroll ? '@min-[1150px]:sticky @min-[1150px]:top-[calc(var(--app-header-height)+var(--document-viewport-gap))] @min-[1150px]:[&>aside]:max-h-[calc(100dvh-var(--app-header-height)-2*var(--document-viewport-gap))] @min-[1150px]:[&>aside]:overflow-y-auto @min-[1150px]:[&>aside]:overscroll-contain' : ''}`}
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
