<script lang="ts">
	import { setConvexClientContext } from 'convex-svelte';
	import { useAccountContext } from './account-context.svelte';
	import type { Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
	const account = useAccountContext()!;
	setConvexClientContext(account.client!);
</script>

{@render children()}
