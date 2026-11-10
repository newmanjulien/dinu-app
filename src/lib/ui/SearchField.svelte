<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import type { ClassValue } from 'clsx';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import { cn } from './cn';

	type Props = Omit<HTMLInputAttributes, 'type' | 'value' | 'class' | 'children' | 'aria-label'> & {
		label: string;
		value?: string;
		element?: HTMLInputElement | null;
		clearable?: boolean;
		class?: ClassValue;
	};

	let {
		label,
		value = $bindable(''),
		element = $bindable(),
		clearable = true,
		class: className,
		disabled = false,
		readonly = false,
		'aria-disabled': ariaDisabled,
		'aria-invalid': ariaInvalid,
		...attributes
	}: Props = $props();
</script>

<svelte:element
	this={clearable ? 'div' : 'label'}
	aria-disabled={disabled || ariaDisabled || undefined}
	aria-invalid={ariaInvalid}
	class={cn(
		'flex h-[35px] w-full min-w-0 items-center gap-[7px] rounded-button-lg border-hairline border-edge bg-surface px-[11px] text-ink shadow-control outline-none transition-[background-color] focus-within:border-accent focus-within:outline-solid focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent/18 not-aria-disabled:aria-invalid:border-danger/30 not-aria-disabled:aria-invalid:bg-danger-surface not-aria-disabled:aria-invalid:text-danger not-aria-disabled:aria-invalid:focus-within:border-danger not-aria-disabled:aria-invalid:focus-within:outline-danger/18 aria-disabled:bg-canvas aria-disabled:text-ink-muted has-[:disabled]:bg-canvas has-[:disabled]:text-ink-muted motion-reduce:transition-none',
		!readonly &&
			'not-aria-disabled:not-aria-invalid:not-has-[:disabled]:hover:not-focus-within:bg-field-hover',
		readonly && 'bg-canvas text-ink-muted',
		className
	)}
>
	<MagnifyingGlassIcon aria-hidden="true" class="size-[17px] shrink-0 text-ink-muted" />
	<input
		{...attributes}
		bind:this={element}
		bind:value
		type="search"
		aria-label={label}
		aria-disabled={ariaDisabled}
		aria-invalid={ariaInvalid}
		{disabled}
		{readonly}
		class="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-inherit outline-none placeholder:font-[350] placeholder:text-ink-muted [&::-webkit-search-cancel-button]:hidden"
	/>
	{#if clearable && value && !readonly}
		<button
			type="button"
			aria-label="Clear search"
			disabled={disabled || ariaDisabled === true || ariaDisabled === 'true'}
			class="-mr-1 flex size-[23px] shrink-0 cursor-pointer items-center justify-center rounded-button-sm text-ink-muted transition-colors not-disabled:hover:bg-control-hover not-disabled:hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:text-ink-muted motion-reduce:transition-none"
			onclick={() => {
				value = '';
				element?.focus();
			}}
		>
			<XIcon class="size-[15px]" aria-hidden="true" />
		</button>
	{/if}
</svelte:element>
