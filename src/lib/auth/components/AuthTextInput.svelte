<script lang="ts">
	import { tick } from 'svelte';
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { fieldClass } from '$lib/ui/field-styles';

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
		class={`${fieldClass} box-border h-10 leading-none`}
	/>
</label>
