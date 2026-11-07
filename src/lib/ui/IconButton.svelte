<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ClassValue } from 'clsx';
	import Button from '$lib/ui/Button.svelte';
	import { cn } from '$lib/ui/cn';
	import type { ButtonHref, ButtonType, ButtonVariant } from '$lib/ui/types';

	type Props = {
		'aria-label': string;
		'aria-describedby'?: string;
		variant?: ButtonVariant;
		type?: ButtonType;
		href?: ButtonHref;
		disabled?: boolean;
		class?: ClassValue;
		onclick?: (event: MouseEvent) => void;
		children?: Snippet;
	};

	let {
		'aria-label': ariaLabel,
		'aria-describedby': ariaDescribedBy,
		variant = 'secondary',
		type = 'button',
		href,
		disabled = false,
		class: className = '',
		onclick,
		children
	}: Props = $props();
</script>

<Button
	{variant}
	{type}
	{href}
	{disabled}
	{onclick}
	aria-label={ariaLabel}
	aria-describedby={ariaDescribedBy}
	class={cn(
		'size-8 gap-0 rounded-button-md p-0 text-[length:inherit] font-[number:inherit]',
		className
	)}
>
	{@render children?.()}
</Button>
