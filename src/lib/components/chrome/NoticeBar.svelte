<script lang="ts">
	import type { ComponentProps, Snippet } from 'svelte';
	import Button from '$lib/ui/Button.svelte';

	type Action = Pick<
		ComponentProps<typeof Button>,
		'href' | 'onclick' | 'disabled' | 'aria-haspopup'
	> & {
		label: string;
	};
	let { children, action }: { children: Snippet; action?: Action } = $props();
</script>

<div
	class="flex min-h-[41px] flex-wrap items-center justify-between gap-x-5 gap-y-2 border-t-[length:var(--surface-border-width)] border-line bg-[color-mix(in_srgb,var(--color-accent)_5%,white)] px-3 py-1 text-[12.5px] font-normal leading-relaxed text-ink sm:px-5"
>
	<p class="min-w-0 flex-1 basis-[400px]" role="status" aria-live="polite" aria-atomic="true">
		{@render children()}
	</p>
	{#if action}
		<Button
			variant="secondary"
			href={action.href}
			onclick={action.onclick}
			disabled={action.disabled}
			aria-haspopup={action['aria-haspopup']}
			class="h-[31px] rounded-[7px]! self-center px-[9.5px] py-1 text-[11.75px] shadow-none not-disabled:not-aria-disabled:hover:bg-field-hover disabled:bg-field-hover"
			>{action.label}</Button
		>
	{/if}
</div>
