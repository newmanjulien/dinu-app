<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import SquareIconButton from '$lib/components/ui/SquareIconButton.svelte';

	type Props = Omit<HTMLButtonAttributes, 'class' | 'type' | 'aria-label'> & {
		label: string;
		caption: string;
		href?: string;
		element?: HTMLButtonElement | null;
		children: Snippet;
	};
	let {
		label,
		caption,
		href,
		element = $bindable(),
		children: icon,
		disabled = false,
		...buttonAttributes
	}: Props = $props();
</script>

{#if href}
	<a
		{href}
		aria-label={label}
		class="flex flex-col items-center gap-[3px] rounded-button-lg text-[9.5px] leading-[1.2] text-ink-secondary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent min-[1000px]:focus-visible:outline-offset-2"
	>
		<span
			class="grid size-[35px] place-items-center rounded-button-lg hover:bg-control-hover min-[1000px]:size-8 max-[999px]:in-focus-visible:bg-control-hover"
		>
			{@render icon()}
		</span>
		<span aria-hidden="true" class="hidden min-[1000px]:block">{caption}</span>
	</a>
{:else}
	<span
		class="flex flex-col items-center gap-[3px] text-[9.5px] leading-[1.2] text-ink-secondary"
		class:text-ink-muted={disabled}
		class:opacity-70={disabled}
	>
		<SquareIconButton
			bind:element
			{...buttonAttributes}
			type="button"
			aria-label={label}
			class="rounded-button-lg min-[1000px]:size-8 aria-disabled:cursor-default aria-disabled:text-ink-muted aria-disabled:hover:bg-transparent"
		>
			{@render icon()}
		</SquareIconButton>
		<span aria-hidden="true" class="hidden max-w-16 text-center min-[1000px]:block">
			{caption}
		</span>
	</span>
{/if}
