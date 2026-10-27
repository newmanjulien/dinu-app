<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ClassValue } from 'clsx';
	import { cn } from '$lib/ui/cn';
	import InfoIcon from 'phosphor-svelte/lib/InfoIcon';

	let {
		label,
		class: className = '',
		children
	}: { label?: string; class?: ClassValue; children?: Snippet } = $props();
</script>

<aside
	class={cn(
		'flex w-full items-start gap-2.5 rounded-xl bg-[color-mix(in_srgb,var(--color-accent)_5%,white)] px-4 py-3 text-[13px] leading-relaxed text-ink',
		className
	)}
>
	<InfoIcon size={16} weight="regular" class="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
	<div class="min-w-0">
		{#if label}
			<span class="font-semibold text-ink">{label}</span>
		{/if}
		{#if children}
			<span class={label ? 'ml-1' : undefined}>
				{@render children()}
			</span>
		{/if}
	</div>
</aside>
