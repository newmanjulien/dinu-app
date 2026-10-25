<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from './cn';
	import LoadingWheel from './LoadingWheel.svelte';

	let {
		layout = 'section',
		label,
		children,
		class: className
	}: {
		layout?: 'screen' | 'workspace' | 'section';
		label?: string;
		children?: Snippet;
		class?: string;
	} = $props();

	const layouts = {
		screen: 'min-h-dvh bg-page p-8',
		workspace:
			'min-h-[calc(100dvh-var(--app-header-height)-var(--workspace-loading-inset,0px))] p-8',
		section: 'py-8'
	};
</script>

<div
	class={cn(
		'grid place-content-center justify-items-center gap-4 text-center text-sm',
		layouts[layout],
		className
	)}
>
	{#if label}<LoadingWheel {label} />{/if}
	{@render children?.()}
</div>
