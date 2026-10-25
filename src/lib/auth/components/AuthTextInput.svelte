<script lang="ts">
	import { tick } from 'svelte';
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { cn } from '$lib/ui/cn';

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
	const fieldClass =
		'w-full rounded-button-lg border-[0.5px] border-[#e5e5e5] bg-surface px-3 text-[13px] text-ink shadow-[0_1px_3px] shadow-ink/6 outline-none transition-colors placeholder:font-[350] placeholder:text-[#8a8a8a] hover:not-focus:bg-[#f3f3f3] focus:border-accent focus:ring-[1px] focus:ring-inset focus:ring-accent disabled:bg-stone-50 disabled:text-ink-muted disabled:opacity-55 disabled:hover:bg-stone-50 motion-reduce:transition-none';

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
		class={cn(
			fieldClass,
			'box-border h-10 leading-none',
			invalid &&
				'border-danger/30 bg-danger-surface text-danger hover:bg-danger-surface focus:border-danger focus:ring-danger'
		)}
	/>
</label>
