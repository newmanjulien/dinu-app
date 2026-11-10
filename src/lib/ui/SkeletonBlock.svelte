<script lang="ts">
	import { cn } from './cn';
	import type { Snippet } from 'svelte';
	let { class: className = '', children }: { class?: string; children?: Snippet } = $props();
</script>

<div
	aria-hidden="true"
	class={cn(
		'animate-pulse rounded bg-fill-subtle/70 motion-reduce:animate-none',
		!children && 'h-[15px]',
		className
	)}
>
	{#if children}<span class="invisible">{@render children()}</span>{/if}
</div>
