<script lang="ts">
	import { cn } from '$lib/ui/cn';
	let { label = 'Loading', class: className = '' }: { label?: string; class?: string } = $props();
</script>

<span class={cn('inline-flex size-6 shrink-0', className)} role="status">
	<svg
		class="size-full animate-spin text-line-strong [animation-duration:1s] [animation-timing-function:steps(12)] motion-reduce:animate-none"
		viewBox="0 0 24 24"
		fill="none"
		aria-hidden="true"
	>
		{#each Array.from({ length: 12 }, (_, index) => index) as spoke}
			<line
				x1="12"
				y1="2.5"
				x2="12"
				y2="6.5"
				stroke="currentColor"
				stroke-width="1.5"
				stroke-linecap="round"
				transform={`rotate(${spoke * 30} 12 12)`}
				opacity={0.2 + (spoke / 11) * 0.8}
			/>
		{/each}
	</svg>
	<span class="sr-only">{label}</span>
</span>
