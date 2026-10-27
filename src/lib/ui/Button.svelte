<script lang="ts">
	import { resolve } from '$app/paths';
	import type { Snippet } from 'svelte';
	import type { ClassValue } from 'clsx';
	import { cn } from '$lib/ui/cn';
	import { secondaryButtonClass } from '$lib/ui/button-styles';
	import type { ButtonHref, ButtonSize, ButtonType, ButtonVariant } from '$lib/ui/types';

	type Props = {
		'aria-label'?: string;
		'aria-describedby'?: string;
		'aria-keyshortcuts'?: string;
		'aria-live'?: 'off' | 'polite' | 'assertive';
		variant?: ButtonVariant;
		size?: ButtonSize;
		type?: ButtonType;
		href?: ButtonHref;
		form?: string;
		title?: string;
		disabled?: boolean;
		class?: ClassValue;
		onclick?: (event: MouseEvent) => void;
		children?: Snippet;
		leading?: Snippet;
		trailing?: Snippet;
	};

	let {
		'aria-label': ariaLabel,
		'aria-describedby': ariaDescribedBy,
		'aria-keyshortcuts': ariaKeyshortcuts,
		'aria-live': ariaLive,
		variant = 'primary',
		size = 'sm',
		type = 'button',
		href,
		form,
		title,
		disabled = false,
		class: className = '',
		onclick,
		children,
		leading,
		trailing
	}: Props = $props();

	function handleClick(event: MouseEvent) {
		if (disabled) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}

		onclick?.(event);
	}

	const buttonClass = $derived(
		cn(
			'inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-button-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:text-ink-muted aria-disabled:cursor-default aria-disabled:text-ink-muted motion-reduce:transition-none',
			size === 'sm'
				? 'h-button-sm gap-1.5 px-3.5 py-2 text-[12.5px] font-normal'
				: 'size-8 rounded-button-md p-0',
			variant !== 'ghost' && 'disabled:bg-canvas aria-disabled:bg-canvas',
			variant === 'primary' &&
				'bg-ink text-surface not-disabled:not-aria-disabled:hover:bg-ink-secondary',
			variant === 'secondary' &&
				`${secondaryButtonClass} text-ink disabled:shadow-none aria-disabled:shadow-none`,
			variant === 'ghost' &&
				'text-ink-secondary not-disabled:not-aria-disabled:hover:bg-control-fill disabled:bg-transparent aria-disabled:bg-transparent',
			className
		)
	);
</script>

{#if href}
	<a
		class={buttonClass}
		class:pointer-events-none={disabled}
		href={resolve(href as '/')}
		{title}
		aria-label={ariaLabel}
		aria-describedby={ariaDescribedBy}
		aria-keyshortcuts={ariaKeyshortcuts}
		aria-live={ariaLive}
		aria-disabled={disabled || undefined}
		tabindex={disabled ? -1 : undefined}
		onclick={handleClick}
	>
		{@render leading?.()}
		{@render children?.()}
		{@render trailing?.()}
	</a>
{:else}
	<button
		{type}
		{form}
		{title}
		class={buttonClass}
		aria-label={ariaLabel}
		aria-describedby={ariaDescribedBy}
		aria-keyshortcuts={ariaKeyshortcuts}
		aria-live={ariaLive}
		{disabled}
		onclick={handleClick}
	>
		{@render leading?.()}
		{@render children?.()}
		{@render trailing?.()}
	</button>
{/if}
