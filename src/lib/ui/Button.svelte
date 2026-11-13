<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ClassValue } from 'clsx';
	import { cn } from '$lib/ui/cn';
	import type { ButtonHref, ButtonType, ButtonVariant } from '$lib/ui/types';

	type Props = {
		'aria-label'?: string;
		'aria-describedby'?: string;
		'aria-keyshortcuts'?: string;
		'aria-live'?: 'off' | 'polite' | 'assertive';
		'aria-haspopup'?: 'dialog';
		variant?: ButtonVariant;
		type?: ButtonType;
		href?: ButtonHref;
		form?: string;
		title?: string;
		disabled?: boolean;
		class?: ClassValue;
		onclick?: (event: MouseEvent) => void;
		onkeydown?: (event: KeyboardEvent) => void;
		onpointerenter?: (event: PointerEvent) => void;
		onpointerdown?: (event: PointerEvent) => void;
		onfocus?: (event: FocusEvent) => void;
		children?: Snippet;
		leading?: Snippet;
		trailing?: Snippet;
	};

	let {
		'aria-label': ariaLabel,
		'aria-describedby': ariaDescribedBy,
		'aria-keyshortcuts': ariaKeyshortcuts,
		'aria-live': ariaLive,
		'aria-haspopup': ariaHasPopup,
		variant = 'primary',
		type = 'button',
		href,
		form,
		title,
		disabled = false,
		class: className = '',
		onclick,
		onkeydown,
		onpointerenter,
		onpointerdown,
		onfocus,
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
</script>

<svelte:element
	this={href ? 'a' : 'button'}
	role={href ? 'link' : 'button'}
	type={href ? undefined : type}
	form={href ? undefined : form}
	disabled={href ? undefined : disabled}
	class={cn(
		'inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-button-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:text-ink-muted aria-disabled:cursor-default aria-disabled:text-ink-muted motion-reduce:transition-none',
		'h-button-sm gap-1 px-[13px] py-[7.5px] text-[12.5px] font-normal',
		variant !== 'ghost' && 'disabled:bg-canvas aria-disabled:bg-canvas',
		variant === 'primary' &&
			'bg-ink text-surface not-disabled:not-aria-disabled:hover:bg-ink-secondary',
		variant === 'secondary' &&
			'border-hairline border-edge bg-surface shadow-control transition-colors not-disabled:not-aria-disabled:hover:bg-surface-hover motion-reduce:transition-none text-ink disabled:shadow-none aria-disabled:shadow-none',
		variant === 'ghost' &&
			'text-ink-secondary not-disabled:not-aria-disabled:hover:bg-control-hover disabled:bg-transparent aria-disabled:bg-transparent',
		className
	)}
	class:pointer-events-none={Boolean(href && disabled)}
	href={href || undefined}
	{title}
	aria-label={ariaLabel}
	aria-describedby={ariaDescribedBy}
	aria-keyshortcuts={ariaKeyshortcuts}
	aria-live={ariaLive}
	aria-haspopup={ariaHasPopup}
	aria-disabled={href && disabled ? true : undefined}
	tabindex={href && disabled ? -1 : undefined}
	onclick={handleClick}
	{onkeydown}
	{onpointerenter}
	{onpointerdown}
	{onfocus}
>
	{@render leading?.()}
	{@render children?.()}
	{@render trailing?.()}
</svelte:element>
