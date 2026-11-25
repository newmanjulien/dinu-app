<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import type { LayoutData } from './$types';
	import ContractRoute from '$lib/components/workspace/ContractRoute.svelte';
	import { getWorkspaceRuntime } from '$lib/auth/workspace-context.svelte';
	let { data, children }: { data: LayoutData; children: Snippet } = $props();
	const runtime = getWorkspaceRuntime();
	let mounted = $state(untrack(() => !runtime.paused));
	$effect(() => {
		if (!runtime.paused) mounted = true;
	});
</script>

{#if mounted}
	<div hidden={runtime.paused} inert={runtime.paused}>
		<ContractRoute data={data.contractDestination} />
	</div>
{/if}
{@render children()}
