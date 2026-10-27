<script lang="ts">
	import { onDestroy, type Snippet } from 'svelte';
	import FloatingSurface from './FloatingSurface.svelte';
	import type { CloseReason } from './interactions';
	let {
		open,
		trigger,
		onClose,
		id,
		label,
		children
	}: {
		open: boolean;
		trigger?: HTMLElement;
		onClose: (reason: CloseReason) => void;
		id: string;
		label: string;
		children: Snippet<[() => void]>;
	} = $props();
	let element = $state<HTMLDivElement>();
	let tabTimer: ReturnType<typeof setTimeout> | undefined;
	onDestroy(() => clearTimeout(tabTimer));
	function items() {
		return Array.from(
			element?.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]') ??
				[]
		).filter((item) => !item.matches(':disabled'));
	}
	function keydown(event: KeyboardEvent) {
		const enabled = items();
		const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
		const index =
			event.key === 'Home'
				? 0
				: event.key === 'End'
					? enabled.length - 1
					: event.key === 'ArrowDown'
						? (current + 1) % enabled.length
						: event.key === 'ArrowUp'
							? (current - 1 + enabled.length) % enabled.length
							: undefined;
		if (index !== undefined) {
			event.preventDefault();
			enabled[index]?.focus({ preventScroll: true });
		} else if (event.key === 'Tab') {
			// Let native Tab move focus before hiding the focused menu item.
			tabTimer = setTimeout(() => {
				if (open) close('focus-leaving');
			}, 0);
		}
	}
	function close(reason: CloseReason) {
		clearTimeout(tabTimer);
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
	role="menu"
	{label}
	dismissOnFocus
	bind:element
	onReady={() => {
		const enabled = items();
		const selected = enabled.find((item) => item.getAttribute('aria-checked') === 'true');
		(selected ?? enabled[0])?.focus({ preventScroll: true });
	}}
	onkeydown={keydown}
	class="rounded-base border-hairline border-edge bg-surface p-1 shadow-floating"
>
	{@render children(() => close('activation'))}
</FloatingSurface>
