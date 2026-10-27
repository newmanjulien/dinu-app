<script lang="ts">
	import type { Snippet } from 'svelte';
	import FloatingSurface from './FloatingSurface.svelte';
	import type { CloseReason } from './interactions';
	let {
		open,
		trigger,
		onClose,
		id,
		label,
		keyboard = false,
		children
	}: {
		open: boolean;
		trigger?: HTMLElement;
		onClose: (reason: CloseReason) => void;
		id: string;
		label: string;
		keyboard?: boolean;
		children: Snippet;
	} = $props();
	let element = $state<HTMLDivElement>();
	function close(reason: CloseReason) {
		onClose(reason);
		if (
			(reason === 'escape' || reason === 'activation') &&
			trigger?.isConnected &&
			!trigger.matches(':disabled')
		)
			trigger.focus({ preventScroll: true });
	}
</script>

<FloatingSurface
	{open}
	{trigger}
	onClose={close}
	{id}
	role="group"
	{label}
	placement="bottom-start"
	matchWidth
	dismissOnFocus
	bind:element
	onReady={() => {
		if (keyboard)
			element
				?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled), [tabindex="0"]')
				?.focus({ preventScroll: true });
	}}
	class="rounded-base border-hairline border-edge bg-surface p-1 shadow-floating"
>
	{@render children()}
</FloatingSurface>
