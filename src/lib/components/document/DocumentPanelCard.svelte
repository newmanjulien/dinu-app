<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/ui/cn';
	let {
		children,
		label,
		selected = false,
		viewportScrollable = false
	}: {
		children: Snippet;
		label: string;
		selected?: boolean;
		viewportScrollable?: boolean;
	} = $props();
</script>

<aside
	aria-label={label}
	class={cn(
		'relative flex min-w-0 w-full flex-col rounded-base border-hairline border-edge bg-surface text-[14px] leading-[1.45] text-ink shadow-card',
		selected && 'border-control-border/75 shadow-[0_2px_5px_#2021240c,0_5px_13px_#2021240b]',
		viewportScrollable &&
			'max-h-[calc(100cqh-2*var(--document-viewport-gap))] overflow-y-auto overscroll-contain'
	)}
>
	{@render children()}
</aside>
