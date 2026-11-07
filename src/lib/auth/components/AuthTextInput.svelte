<script lang="ts">
	import { tick } from 'svelte';
	import type { HTMLInputAttributes } from 'svelte/elements';

	type Props = {
		label: string;
		value: string;
		placeholder?: string;
		type?: 'email' | 'text' | 'url';
		autocomplete?: HTMLInputAttributes['autocomplete'];
		inputmode?: HTMLInputAttributes['inputmode'];
		required?: boolean;
		disabled?: boolean;
		maxlength?: number;
		autofocus?: boolean;
		invalid?: boolean;
	};

	let {
		label,
		value = $bindable(),
		placeholder = '',
		type = 'text',
		autocomplete,
		inputmode,
		required = false,
		disabled = false,
		maxlength,
		autofocus = false,
		invalid = false
	}: Props = $props();

	let inputElement = $state<HTMLInputElement | null>(null);

	$effect(() => {
		if (!autofocus || !inputElement) {
			return;
		}

		tick().then(() => {
			if (inputElement && !inputElement.value && document.activeElement === document.body)
				inputElement.focus();
		});
	});
</script>

<label class="block min-w-0">
	<span class="sr-only">{label}</span>
	<input
		bind:this={inputElement}
		bind:value
		placeholder={placeholder || label}
		{type}
		{autocomplete}
		{inputmode}
		{required}
		{disabled}
		{maxlength}
		aria-invalid={invalid}
		class="w-full rounded-button-lg border-hairline border-edge bg-surface px-3 shadow-control outline-none transition-[background-color] focus-within:border-accent focus-within:outline-solid focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent/18 not-disabled:not-aria-disabled:[&:not([readonly])]:not-aria-invalid:hover:not-focus-within:bg-field-hover not-disabled:not-aria-disabled:aria-invalid:border-danger/30 not-disabled:not-aria-disabled:aria-invalid:bg-danger-surface not-disabled:not-aria-disabled:aria-invalid:text-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:border-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:outline-danger/18 motion-reduce:transition-none min-w-0 text-[13px] placeholder:font-[350] placeholder:text-ink-muted text-ink disabled:bg-canvas disabled:text-ink-muted [&[readonly]]:bg-canvas [&[readonly]]:text-ink-muted box-border h-10 leading-none"
	/>
</label>
