<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	let { announcement, children }: { announcement: object | null; children: Snippet } = $props();
	let element: HTMLDivElement;

	function promote() {
		if (typeof element?.showPopover !== 'function') return;
		if (element.matches(':popover-open')) element.hidePopover();
		element.showPopover();
	}

	onMount(() => {
		promote();
		return () => {
			if (typeof element.hidePopover === 'function' && element.matches(':popover-open'))
				element.hidePopover();
		};
	});
	$effect(() => {
		// Keep new status messages above other surfaces in the browser top layer.
		if (announcement) promote();
	});
</script>

<div
	bind:this={element}
	popover="manual"
	class="pointer-events-none fixed inset-x-0 top-[calc(var(--app-header-height)+20px)] bottom-auto m-0 flex h-fit w-full max-w-none justify-center overflow-visible border-0 bg-transparent p-0 text-ink max-[999px]:top-[calc(var(--app-header-height)+8px)] max-[999px]:right-3 max-[999px]:left-auto max-[999px]:w-[min(454px,calc(100vw-24px))] max-[999px]:flex-col max-[999px]:items-end max-[999px]:gap-2"
>
	{@render children()}
</div>
