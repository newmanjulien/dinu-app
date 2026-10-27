<script lang="ts">
	import type { Snippet } from 'svelte';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
	let {
		value,
		label,
		open = $bindable(null),
		danger = false,
		children
	}: {
		value: string;
		label: string;
		open: string | null;
		danger?: boolean;
		children: Snippet;
	} = $props();
	const id = $props.id();
</script>

<div>
	<button
		class={`flex w-full cursor-pointer items-center gap-2 rounded-button-lg border-0 px-3 py-2.5 text-left text-[14px] leading-[1.3] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${danger ? 'bg-danger-surface text-danger hover:bg-danger-surface-hover' : 'bg-canvas text-ink hover:bg-control-fill'}`}
		type="button"
		aria-expanded={open === value}
		aria-controls={`${id}-body`}
		onclick={() => (open = open === value ? null : value)}
	>
		<span class="min-w-0">{label}</span>
		<CaretDownIcon
			aria-hidden="true"
			size={14}
			weight="bold"
			class={`ml-auto shrink-0 ${danger ? 'text-danger/30' : 'text-ink-muted/25'}`}
		/>
	</button>
	<div
		id={`${id}-body`}
		class="mt-2 mb-1 flex flex-col gap-3 px-1 text-[14px] leading-[1.45] text-ink-muted"
		hidden={open !== value}
	>
		{@render children()}
	</div>
</div>
