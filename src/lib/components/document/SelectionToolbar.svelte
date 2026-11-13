<script lang="ts">
	import type ArticleIcon from 'phosphor-svelte/lib/ArticleIcon';
	import FloatingSurface from '$lib/components/ui/FloatingSurface.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import SquareIconButton from '$lib/components/ui/SquareIconButton.svelte';
	import type { FloatingVirtualAnchor } from '$lib/components/ui/floating';
	import type { CloseReason } from '$lib/components/ui/interactions';

	let {
		anchor,
		actions,
		onClose,
		element = $bindable()
	}: {
		anchor: FloatingVirtualAnchor;
		actions: readonly {
			id: string;
			label: string;
			icon: typeof ArticleIcon;
			enabled?: boolean;
			reason?: string;
			onSelect: () => void;
		}[];
		onClose: (reason: CloseReason) => void;
		element?: HTMLDivElement | null;
	} = $props();
	const buttons = $state<Record<string, HTMLButtonElement | null>>({});
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
	label="Selection actions"
	class="flex h-[33px] items-center rounded-xl border-hairline border-edge bg-surface p-0.5 shadow-floating"
	onpointerdown={preserveSelection}
>
	{#each actions as action (action.id)}
		{@const enabled = action.enabled !== false}
		<Tooltip
			text={enabled ? action.label : (action.reason ?? action.label)}
			trigger={buttons[action.id] ?? undefined}
			standalone={false}
			leaveDelay={0}
			onpointerdown={preserveSelection}
		>
			{#snippet children(descriptionId)}
				<SquareIconButton
					bind:element={buttons[action.id]}
					class="size-[27px] rounded-[9.5px]"
					type="button"
					disabled={!enabled}
					aria-describedby={descriptionId}
					onclick={action.onSelect}
					aria-label={enabled ? action.label : `${action.label}: ${action.reason}`}
				>
					<action.icon aria-hidden="true" class="size-5" weight="regular" />
				</SquareIconButton>
			{/snippet}
		</Tooltip>
	{/each}
</FloatingSurface>
