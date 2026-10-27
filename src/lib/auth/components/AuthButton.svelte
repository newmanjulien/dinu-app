<script lang="ts">
	import type { Snippet } from 'svelte';
	import Button from '$lib/ui/Button.svelte';
	import { accentButtonClass } from '$lib/ui/button-styles';
	import type { ButtonHref } from '$lib/ui/types';

	type Props = {
		type?: 'button' | 'submit';
		href?: ButtonHref;
		'aria-keyshortcuts'?: string;
		disabled?: boolean;
		children: Snippet;
		onclick?: () => void;
		variant?: 'primary' | 'secondary';
	};

	let {
		type = 'button',
		href,
		disabled = false,
		children,
		onclick,
		variant = 'primary',
		'aria-keyshortcuts': ariaKeyshortcuts
	}: Props = $props();
</script>

<Button
	{type}
	{href}
	{disabled}
	{onclick}
	{variant}
	aria-keyshortcuts={ariaKeyshortcuts}
	class={[
		'relative h-auto min-h-button-sm w-full whitespace-normal [overflow-wrap:anywhere]',
		variant === 'primary' && accentButtonClass
	]}
>
	{@render children()}
</Button>
