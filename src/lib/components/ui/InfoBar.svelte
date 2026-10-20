<script lang="ts">
	import type { Snippet } from 'svelte';
	import { clsx, type ClassValue } from 'clsx';
	import { twMerge } from 'tailwind-merge';
	import InfoIcon from 'phosphor-svelte/lib/InfoIcon';

	let {
		label,
		class: className = '',
		children
	}: { label?: string; class?: ClassValue; children?: Snippet } = $props();
</script>

<aside
	class={twMerge(
		clsx(
			'flex w-full items-start gap-2.5 rounded-xl bg-[color-mix(in_srgb,var(--color-accent)_5%,white)] px-4 py-3 text-[13px] leading-relaxed text-stone-900',
			className
		)
	)}
>
	<InfoIcon size={16} weight="regular" class="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
	<div class="min-w-0">
		{#if label}
			<span class="font-semibold text-stone-950">{label}</span>
		{/if}
		{#if children}
			<span class={label ? 'ml-1' : undefined}>
				{@render children()}
			</span>
		{/if}
	</div>
</aside>
