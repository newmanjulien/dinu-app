<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';

	type Props = Omit<HTMLButtonAttributes, 'class' | 'role' | 'aria-checked' | 'type'> & {
		children: Snippet;
		checked?: boolean;
		danger?: boolean;
	};

	let { children, checked, danger = false, ...buttonAttributes }: Props = $props();
</script>

<button
	{...buttonAttributes}
	type="button"
	role={checked === undefined ? 'menuitem' : 'menuitemradio'}
	aria-checked={checked}
	tabindex="-1"
	class={[
		'flex w-full cursor-pointer items-center justify-between gap-5 rounded-button-lg border-0 bg-transparent px-3 py-2 text-left text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:text-ink-muted disabled:hover:bg-transparent',
		danger
			? 'text-danger hover:bg-danger-surface focus-visible:bg-danger-surface'
			: 'text-ink-secondary hover:bg-surface-hover focus-visible:bg-surface-hover'
	]}
>
	{@render children()}
	{#if checked !== undefined}<span aria-hidden="true">{checked ? '✓' : ''}</span>{/if}
</button>
