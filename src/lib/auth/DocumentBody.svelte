<script lang="ts">
	import { type Snippet } from 'svelte';
	import { useViewer } from './viewer-session.svelte';
	import { getWorkspaceRuntime } from './workspace-context.svelte';
	import BaselineSetup from '$lib/components/template/BaselineSetup.svelte';
	import LoadingState from '$lib/ui/LoadingState.svelte';
	import WorkspaceSkeleton from './WorkspaceSkeleton.svelte';
	let {
		children,
		requiresBaseline = false,
		requiresDocument = true
	}: { children?: Snippet; requiresBaseline?: boolean; requiresDocument?: boolean } = $props();
	const runtime = getWorkspaceRuntime();
	const viewer = useViewer();
	const baselinePending = $derived(requiresBaseline && !viewer().templateReady);
	let mounted = $state(false);
	$effect(() => {
		if ((!requiresDocument || runtime.ready) && !runtime.paused && !baselinePending) mounted = true;
	});
</script>

{#if baselinePending}
	{#if !runtime.paused}
		<BaselineSetup getNavigationIntent={() => runtime.navigationIntent} />
	{/if}
{:else if mounted}
	<div hidden={runtime.paused} inert={runtime.paused}>{@render children?.()}</div>
{:else if !runtime.paused && !runtime.ready}
	{#if !runtime.error}
		<WorkspaceSkeleton label="Loading document viewer" />
	{:else}
		<LoadingState layout="workspace">
			<p role="alert" class="text-sm">{runtime.error}</p>
			<button class="text-sm underline" onclick={runtime.retry}>Try again</button>
		</LoadingState>
	{/if}
{/if}
