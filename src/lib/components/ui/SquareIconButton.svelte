<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';

	type Props = Omit<HTMLButtonAttributes, 'class'> & {
		children: Snippet;
		element?: HTMLButtonElement;
		size?: 'sm' | 'md';
		rounded?: 'md' | 'lg';
	};

	let {
		children,
		element = $bindable(),
		size = 'md',
		rounded = 'md',
		...buttonAttributes
	}: Props = $props();
</script>

<button
	bind:this={element}
	{...buttonAttributes}
	class={`grid ${size === 'sm' ? 'size-7' : 'size-9'} ${rounded === 'lg' ? 'rounded-button-md' : 'rounded-button-sm'} cursor-pointer place-items-center border border-transparent bg-transparent p-0 text-ink-secondary shadow-none hover:bg-control-fill focus-visible:bg-control-fill focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent aria-expanded:bg-control-fill aria-pressed:bg-accent aria-pressed:text-surface aria-pressed:hover:bg-accent-hover aria-pressed:focus-visible:bg-accent-hover disabled:cursor-default disabled:text-ink-muted disabled:hover:bg-transparent [&_svg]:pointer-events-none`}
>
	{@render children()}
</button>
