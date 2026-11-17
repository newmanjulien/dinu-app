<script lang="ts">
	import type { Snippet } from 'svelte';
	import { setDocumentSection } from '$lib/document/runtime/section.svelte';
	import { DESKTOP_TOOL_RAIL_EDGE } from './workspace-layout';

	let {
		heading,
		children,
		active = true
	}: { heading: Snippet; children: Snippet; active?: boolean } = $props();
	let viewport = $state<HTMLDivElement>();
	setDocumentSection({
		identity: Symbol('document-section'),
		get viewport() {
			return viewport;
		},
		get active() {
			return active;
		}
	});
</script>

<div
	class="h-[max(0px,calc(100dvh-var(--app-header-height)))] w-full overflow-auto overscroll-contain [container-type:size] [--tool-rail-edge:0px] min-[1000px]:[--tool-rail-edge:var(--desktop-tool-rail-edge)]"
	bind:this={viewport}
	style:--desktop-tool-rail-edge={`${DESKTOP_TOOL_RAIL_EDGE}px`}
	data-document-viewport
>
	<div class="w-full">{@render heading()}</div>
	{@render children()}
</div>
