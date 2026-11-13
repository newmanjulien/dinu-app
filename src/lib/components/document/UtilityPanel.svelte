<script module lang="ts">
	export type UtilityPanelName = 'search';
</script>

<script lang="ts">
	import { onDestroy, tick, type Snippet } from 'svelte';
	import HeaderContent from '$lib/components/chrome/HeaderContent.svelte';
	import { getInteractionController, protectedInteraction } from '$lib/components/ui/interactions';
	let {
		activePanel = $bindable(null),
		element = $bindable(),
		owner,
		desktop,
		mobile,
		focusTarget,
		onLeave,
		children
	}: {
		activePanel: UtilityPanelName | null;
		element?: HTMLElement;
		owner: symbol | undefined;
		desktop?: HTMLElement;
		mobile?: HTMLElement;
		focusTarget: (
			panel: UtilityPanelName,
			element: HTMLElement | undefined
		) => { element: HTMLElement | null | undefined; preventScroll: boolean };
		onLeave?: (panel: UtilityPanelName) => void;
		children: Snippet<[UtilityPanelName, (restoreFocus?: boolean) => void]>;
	} = $props();
	const interactions = getInteractionController();
	const protect = protectedInteraction();
	const panelId = Symbol('utility-panel');
	let trigger: HTMLButtonElement | undefined;
	let opening = 0;
	onDestroy(() => {
		opening++;
	});
	$effect(() => {
		if (!activePanel) return;
		return interactions.register({
			id: panelId,
			owner,
			kind: 'utility',
			elements: () => [element, mobile, desktop],
			close: (reason) => close(reason === 'escape')
		});
	});
	export function visibleButton(panel: UtilityPanelName) {
		const id = `document-${panel}`;
		return (
			[
				trigger?.getAttribute('aria-controls') === id ? trigger : undefined,
				mobile?.querySelector<HTMLButtonElement>(`[aria-controls="${id}"]`),
				desktop?.querySelector<HTMLButtonElement>(`[aria-controls="${id}"]`)
			].find((button) => button?.isConnected && button.getClientRects().length) ?? undefined
		);
	}
	export function close(restoreFocus = true) {
		const panel = activePanel;
		if (!panel) return;
		const current = ++opening;
		activePanel = null;
		onLeave?.(panel);
		if (restoreFocus)
			void tick().then(() => {
				if (opening === current && !activePanel)
					visibleButton(panel)?.focus({ preventScroll: true });
			});
	}
	export function show(panel: UtilityPanelName, button?: HTMLButtonElement) {
		if (activePanel && activePanel !== panel) onLeave?.(activePanel);
		trigger = button;
		activePanel = panel;
		const current = ++opening;
		void tick().then(() => {
			if (opening !== current || activePanel !== panel) return;
			const target = focusTarget(panel, element);
			target.element?.focus({ preventScroll: target.preventScroll });
		});
	}
</script>

{#if activePanel}
	<HeaderContent>
		<section
			use:protect={owner ?? true}
			bind:this={element}
			id={`document-${activePanel}`}
			tabindex="-1"
			aria-label="Search"
			data-utility-panel={`document-${activePanel}`}
			class="pointer-events-auto absolute top-0 left-[84px] max-h-[calc(100dvh-var(--app-header-height)-40px)] w-[378px] overflow-y-auto overscroll-contain rounded-xl border-hairline border-edge bg-surface p-2.5 text-ink shadow-floating max-[999px]:static max-[999px]:max-h-[calc(100dvh-var(--app-header-height)-16px)] max-[999px]:w-full"
		>
			{@render children(activePanel, close)}
		</section>
	</HeaderContent>
{/if}
