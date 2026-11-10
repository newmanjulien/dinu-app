<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { recordStartup } from './startup-perf';
	onMount(() => recordStartup('placeholder-mounted'));
	let { children }: { children: Snippet } = $props();
</script>

<div class="min-h-dvh bg-page" data-workspace-frame>{@render children()}</div>
