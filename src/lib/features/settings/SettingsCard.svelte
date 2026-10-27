<script lang="ts">
	import type { ClassValue } from 'clsx';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/ui/cn';

	type Props = {
		title: string;
		description?: string | string[];
		class?: ClassValue;
		children?: Snippet;
		media?: Snippet;
		footer?: Snippet;
		action?: Snippet;
	};

	let {
		title,
		description = [],
		class: className = '',
		children,
		media,
		footer,
		action
	}: Props = $props();

	const descriptionLines = $derived(Array.isArray(description) ? description : [description]);
</script>

<article
	class={cn(
		'overflow-hidden rounded-xl border-hairline border-edge bg-surface shadow-card',
		className
	)}
>
	<div
		class="flex min-h-36 flex-col gap-5 px-4 py-5 sm:flex-row sm:items-start sm:justify-between sm:px-5"
	>
		<div class="min-w-0 flex-1">
			<h2 class="text-[0.82rem] leading-5 text-ink">{title}</h2>
			{#if descriptionLines.length > 0}
				<div class="mt-3 space-y-1.5 text-[0.74rem] leading-5 text-ink-muted">
					{#each descriptionLines as line, index (index)}
						<p>{line}</p>
					{/each}
				</div>
			{/if}

			{@render children?.()}
		</div>

		{#if media}
			<div class="shrink-0 self-start sm:self-center">
				{@render media()}
			</div>
		{/if}
	</div>

	{#if footer || action}
		<footer
			class="flex min-h-12 flex-col gap-3 border-t-[length:var(--surface-border-width)] border-line bg-page px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5"
		>
			<div class="min-w-0 text-[0.74rem] leading-5 text-ink-muted">
				{@render footer?.()}
			</div>

			{#if action}
				<div class="flex shrink-0 justify-end">
					{@render action()}
				</div>
			{/if}
		</footer>
	{/if}
</article>
