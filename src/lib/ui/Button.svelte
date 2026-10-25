<script lang="ts">
	import { resolve } from '$app/paths';
	import type { Snippet } from 'svelte';
	import type { ClassValue } from 'clsx';
	import { cn } from '$lib/ui/cn';
	import type { ButtonHref, ButtonSize, ButtonType, ButtonVariant } from '$lib/ui/types';

	type Props = {
		'aria-label'?: string;
		'aria-describedby'?: string;
		'aria-keyshortcuts'?: string;
		variant?: ButtonVariant;
		size?: ButtonSize;
		type?: ButtonType;
		href?: ButtonHref;
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
		variant = 'primary',
		size = 'sm',
		type = 'button',
		href,
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
			'inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-button-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default data-[disabled]:pointer-events-none data-[disabled]:cursor-default motion-reduce:transition-none',
			size === 'sm'
				? 'h-[38px] gap-1.5 px-3.5 py-2 text-[12.5px] font-normal'
				: 'size-8 rounded-button-md p-0',
			variant === 'primary' &&
				'bg-[#171717] text-white hover:bg-[#303030] disabled:hover:bg-stone-100 disabled:bg-stone-100 disabled:text-stone-400 data-[disabled]:bg-stone-100 data-[disabled]:text-stone-400',
			variant === 'secondary' &&
				'border border-[#e5e5e5] bg-surface text-ink hover:bg-[#f3f3f3] disabled:bg-surface disabled:text-ink-muted disabled:opacity-55 data-[disabled]:bg-surface data-[disabled]:text-ink-muted data-[disabled]:opacity-55',
			variant === 'ghost' &&
				'text-ink-secondary hover:bg-[#f3f3f3] disabled:bg-transparent disabled:text-ink-muted disabled:opacity-55 data-[disabled]:bg-transparent data-[disabled]:text-ink-muted data-[disabled]:opacity-55',
			className
		)
	);
</script>

{#if href}
	<a
		class={buttonClass}
		href={resolve(href as '/')}
		aria-label={ariaLabel}
		aria-describedby={ariaDescribedBy}
		aria-keyshortcuts={ariaKeyshortcuts}
		aria-disabled={disabled || undefined}
		data-disabled={disabled || undefined}
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
		class={buttonClass}
		aria-label={ariaLabel}
		aria-describedby={ariaDescribedBy}
		aria-keyshortcuts={ariaKeyshortcuts}
		data-disabled={disabled || undefined}
		{disabled}
		onclick={handleClick}
	>
		{@render leading?.()}
		{@render children?.()}
		{@render trailing?.()}
	</button>
{/if}
