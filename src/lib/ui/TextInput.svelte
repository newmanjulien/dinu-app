<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import type { ClassValue } from 'clsx';
	import { cn } from './cn';

	type Props = Omit<HTMLInputAttributes, 'type' | 'value' | 'class' | 'children'> & {
		type?: 'text' | 'search' | 'email' | 'url' | 'tel' | 'password';
		value?: string;
		element?: HTMLInputElement | null;
		class?: ClassValue;
		tone?: 'accent' | 'neutral';
	};

	let {
		type = 'text',
		value = $bindable(''),
		element = $bindable(),
		class: className,
		tone = 'accent',
		...attributes
	}: Props = $props();
</script>

<input
	{...attributes}
	{type}
	bind:this={element}
	bind:value
	class={cn(
		'block h-9 w-full min-w-0 rounded-button-lg border-hairline border-edge bg-surface px-3 text-[13px] text-ink shadow-control outline-none transition-[background-color] placeholder:font-[350] placeholder:text-ink-muted focus-within:outline-solid focus-within:outline-2 focus-within:outline-offset-1 not-disabled:not-aria-disabled:[&:not([readonly])]:not-aria-invalid:hover:not-focus-within:bg-field-hover not-disabled:not-aria-disabled:aria-invalid:border-danger/30 not-disabled:not-aria-disabled:aria-invalid:bg-danger-surface not-disabled:not-aria-disabled:aria-invalid:text-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:border-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:outline-danger/18 disabled:bg-canvas disabled:text-ink-muted aria-disabled:bg-canvas aria-disabled:text-ink-muted [&[readonly]]:bg-canvas [&[readonly]]:text-ink-muted motion-reduce:transition-none',
		tone === 'neutral'
			? 'focus-within:border-ink focus-within:outline-ink/18'
			: 'focus-within:border-accent focus-within:outline-accent/18',
		className
	)}
/>
