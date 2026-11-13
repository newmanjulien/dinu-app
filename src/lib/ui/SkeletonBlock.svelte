<script lang="ts">
	import { cn } from './cn';
	import type { Snippet } from 'svelte';
	let {
		as = 'div',
		quiet = false,
		class: className = '',
		children
	}: {
		as?: 'div' | 'span';
		quiet?: boolean;
		class?: string;
		children?: Snippet;
	} = $props();
</script>

<svelte:element
	this={as}
	aria-hidden="true"
	class={cn(
		'relative rounded-full bg-skeleton',
		as === 'span' && 'inline-block',
		!children && 'h-[15px]',
		className
	)}
>
	{#if children}<span class="invisible">{@render children()}</span>{/if}
	<!-- Clip the highlight separately so inline text keeps its original baseline. -->
	<span
		class={cn(
			'pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit] after:absolute after:inset-0 after:bg-linear-to-r after:from-transparent after:via-skeleton-highlight after:to-transparent motion-safe:after:animate-skeleton-shimmer motion-reduce:hidden',
			quiet && 'opacity-40'
		)}
	></span>
</svelte:element>
