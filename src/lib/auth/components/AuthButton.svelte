<script lang="ts">
	import type { Snippet } from 'svelte';
	import Button from '$lib/ui/Button.svelte';

	type Props = {
		type?: 'button' | 'submit';
		'aria-keyshortcuts'?: string;
		disabled?: boolean;
		children: Snippet;
		onclick?: () => void;
		variant?: 'primary' | 'secondary';
	};

	let {
		type = 'button',
		disabled = false,
		children,
		onclick,
		variant = 'primary',
		'aria-keyshortcuts': ariaKeyshortcuts
	}: Props = $props();
</script>

<Button
	{type}
	{disabled}
	{onclick}
	{variant}
	aria-keyshortcuts={ariaKeyshortcuts}
	class={[
		'relative w-full',
		variant === 'primary'
			? 'bg-accent hover:bg-accent-hover disabled:bg-accent-soft disabled:text-white disabled:hover:bg-accent-soft data-[disabled]:bg-accent-soft data-[disabled]:text-white'
			: 'h-auto border-stone-200 py-3 text-sm hover:bg-stone-50'
	]}
>
	{@render children()}
</Button>
