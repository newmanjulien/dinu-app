<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/ui/cn';
	import type { HTMLButtonAttributes } from 'svelte/elements';

	type Props = Omit<HTMLButtonAttributes, 'class'> & {
		children: Snippet;
		element?: HTMLButtonElement | null;
		class?: string;
	};

	let {
		children,
		element = $bindable(),
		class: className = '',
		...buttonAttributes
	}: Props = $props();
</script>

<button
	bind:this={element}
	{...buttonAttributes}
	class={cn(
		'grid size-[35px] rounded-button-md cursor-pointer place-items-center border border-transparent bg-transparent p-0 text-ink-secondary shadow-none hover:bg-control-hover focus-visible:bg-control-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent aria-expanded:bg-control-hover aria-pressed:bg-accent aria-pressed:text-surface aria-pressed:hover:bg-accent-hover aria-pressed:focus-visible:bg-accent-hover disabled:cursor-default disabled:text-ink-muted/70 disabled:hover:bg-transparent [&_svg]:pointer-events-none',
		className
	)}
>
	{@render children()}
</button>
