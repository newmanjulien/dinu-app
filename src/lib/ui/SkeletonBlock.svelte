<script lang="ts">
	import { cn } from './cn';
	let { class: className = '' }: { class?: string } = $props();
</script>

<div
	aria-hidden="true"
	class={cn('h-3 animate-pulse rounded bg-fill-subtle/70 motion-reduce:animate-none', className)}
></div>
