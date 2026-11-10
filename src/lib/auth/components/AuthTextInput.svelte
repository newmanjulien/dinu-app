<script lang="ts">
	import TextInput from '$lib/ui/TextInput.svelte';
	import { tick } from 'svelte';
	import type { HTMLInputAttributes } from 'svelte/elements';

	type Props = {
		label: string;
		id?: string;
		visibleLabel?: boolean;
		describedby?: string;
		onblur?: () => void;
		oninput?: (value: string) => void;
		value: string;
		placeholder?: string;
		type?: 'email' | 'text' | 'url' | 'tel';
		autocomplete?: HTMLInputAttributes['autocomplete'];
		inputmode?: HTMLInputAttributes['inputmode'];
		required?: boolean;
		disabled?: boolean;
		maxlength?: number;
		autofocus?: boolean;
		invalid?: boolean;
		tone?: 'accent' | 'neutral';
	};

	let {
		label,
		id,
		visibleLabel = false,
		describedby,
		onblur,
		oninput,
		value = $bindable(),
		placeholder = '',
		type = 'text',
		autocomplete,
		inputmode,
		required = false,
		disabled = false,
		maxlength,
		autofocus = false,
		invalid = false,
		tone = 'accent'
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
	<span class={visibleLabel ? 'mb-2 block text-[13px] font-[450] text-ink' : 'sr-only'}
		>{label}</span
	>
	<TextInput
		bind:element={inputElement}
		bind:value
		{id}
		{onblur}
		oninput={(event) => oninput?.(event.currentTarget.value)}
		aria-describedby={describedby}
		placeholder={placeholder || label}
		{type}
		{autocomplete}
		{inputmode}
		{required}
		{disabled}
		{maxlength}
		aria-invalid={invalid}
		{tone}
		class="box-border h-10 leading-none"
	/>
</label>
