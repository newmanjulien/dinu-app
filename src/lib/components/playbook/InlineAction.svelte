<script lang="ts">
	import type { Snippet } from 'svelte';
	let {
		children,
		href,
		target,
		danger = false,
		disabled = false,
		label,
		describedBy,
		onclick
	}: {
		children: Snippet;
		href?: string;
		target?: '_blank';
		danger?: boolean;
		disabled?: boolean;
		label?: string;
		describedBy?: string;
		onclick?: () => void;
	} = $props();
</script>

<svelte:element
	this={href ? 'a' : 'button'}
	role={href ? 'link' : 'button'}
	type={href ? undefined : 'button'}
	{href}
	{target}
	rel={target === '_blank' ? 'noopener noreferrer' : undefined}
	disabled={href ? undefined : disabled}
	aria-disabled={href && disabled ? true : undefined}
	tabindex={href && disabled ? -1 : undefined}
	aria-label={label}
	aria-describedby={describedBy}
	class={`border-0 bg-transparent p-0 [font:inherit] whitespace-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${disabled ? 'cursor-default opacity-50' : 'cursor-pointer hover:underline'}`}
	class:text-danger={danger}
	class:text-accent={!danger}
	onclick={(event: MouseEvent) => {
		if (disabled) {
			event.preventDefault();
			return;
		}
		onclick?.();
	}}>{@render children()}</svelte:element
>
