<script lang="ts">
	import { onDestroy, type Snippet } from 'svelte';
	import FloatingSurface from './FloatingSurface.svelte';
	import type { CloseReason } from './interactions';
	let {
		text,
		label = text,
		trigger,
		standalone = true,
		enabled = true,
		class:
			className = 'rounded-base border-0 bg-ink-secondary px-2.5 py-2 text-left text-xs leading-[1.4] text-surface',
		children
	}: {
		text: string;
		label?: string;
		trigger?: HTMLElement;
		standalone?: boolean;
		enabled?: boolean;
		class?: string;
		children: Snippet<[string]>;
	} = $props();
	const componentId = $props.id();
	const tooltipId = `${componentId}-tooltip`;
	let infoButton = $state<HTMLButtonElement>();
	let surface = $state<HTMLDivElement>();
	let hovered = false;
	let focused = false;
	let tapped = false;
	let suppressed = false;
	let open = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pointerType = '';
	$effect(() => {
		if (!enabled) {
			cancelTimer();
			open = false;
			tapped = false;
			suppressed = hovered || focused;
		}
	});
	function cancelTimer() {
		clearTimeout(timer);
	}
	function activate() {
		cancelTimer();
		if (enabled && !suppressed) open = true;
	}
	function settle() {
		cancelTimer();
		timer = setTimeout(() => {
			if (!hovered && !focused && !tapped) {
				open = false;
				suppressed = false;
			}
		}, 140);
	}
	function enter(event: PointerEvent) {
		if (event.pointerType === 'touch') return;
		hovered = true;
		activate();
	}
	function leave(event: PointerEvent) {
		if (event.relatedTarget instanceof Node && surface?.contains(event.relatedTarget)) return;
		hovered = false;
		settle();
	}
	function close(reason: CloseReason) {
		cancelTimer();
		open = false;
		tapped = false;
		suppressed = (hovered || focused) && (reason === 'escape' || reason === 'anchor-removal');
	}
	onDestroy(cancelTimer);
</script>

<span
	class="inline-flex"
	role="group"
	onpointerenter={enter}
	onpointerleave={leave}
	onfocusin={(event) => {
		focused = (event.target as HTMLElement).matches(':focus-visible');
		if (focused) activate();
	}}
	onfocusout={(event) => {
		if (event.currentTarget.contains(event.relatedTarget as Node)) return;
		focused = false;
		settle();
	}}
>
	{#if standalone}
		<button
			bind:this={infoButton}
			type="button"
			class="inline-flex cursor-help items-center justify-center rounded-button-sm border-0 bg-transparent p-0 text-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
			aria-label={label}
			aria-describedby={tooltipId}
			onpointerdown={(event) => (pointerType = event.pointerType)}
			onclick={(event) => {
				if (!enabled || pointerType !== 'touch' || event.detail === 0) return;
				suppressed = false;
				tapped = !tapped;
				open = tapped;
			}}
		>
			{@render children(tooltipId)}
		</button>
	{:else}
		{@render children(tooltipId)}
	{/if}
	<FloatingSurface
		open={enabled && open}
		trigger={trigger ?? infoButton}
		onClose={close}
		id={tooltipId}
		role="tooltip"
		kind="tooltip"
		referenceClipping="close"
		maxWidth={288}
		bind:element={surface}
		onpointerenter={enter}
		onpointerleave={(event) => {
			if (
				event.relatedTarget instanceof Node &&
				(trigger ?? infoButton)?.contains(event.relatedTarget)
			)
				return;
			hovered = false;
			settle();
		}}
		class={className}
	>
		{text}
	</FloatingSurface>
</span>
