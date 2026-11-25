<script lang="ts">
	import FloatingSurface from '$lib/components/ui/FloatingSurface.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import type { FloatingVirtualAnchor } from '$lib/components/ui/floating';
	import type { CloseReason } from '$lib/components/ui/interactions';

	let {
		anchor,
		label,
		description,
		onSelect,
		onClose,
		element = $bindable()
	}: {
		anchor: FloatingVirtualAnchor;
		label: string;
		description: string;
		onSelect: () => void;
		onClose: (reason: CloseReason) => void;
		element?: HTMLDivElement | null;
	} = $props();
	let button = $state<HTMLButtonElement | null>(null);
	const preserveSelection = (event: PointerEvent) => event.preventDefault();
</script>

<FloatingSurface
	bind:element
	open={true}
	{anchor}
	{onClose}
	placement="bottom"
	gap={10}
	referenceClipping="hide"
	role="group"
	label="Selection action"
	class="flex items-center rounded-xl border-hairline border-edge bg-surface p-0.5 shadow-floating"
	onpointerdown={preserveSelection}
>
	<Tooltip
		text={description}
		trigger={button ?? undefined}
		placement="bottom"
		standalone={false}
		leaveDelay={0}
		onpointerdown={preserveSelection}
	>
		{#snippet children(descriptionId)}
			<button
				bind:this={button}
				type="button"
				class="inline-flex h-[25px] cursor-pointer items-center justify-center rounded-[9.5px] border-0 bg-transparent px-2 text-[12.5px] leading-none font-normal whitespace-nowrap text-ink transition-colors hover:bg-control-hover focus-visible:bg-control-hover focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-accent motion-reduce:transition-none"
				aria-describedby={descriptionId}
				onclick={onSelect}
			>
				{label}
			</button>
		{/snippet}
	</Tooltip>
</FloatingSurface>
