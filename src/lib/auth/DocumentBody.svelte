<script lang="ts">
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { type Snippet } from 'svelte';
	import { useViewer } from './viewer-session.svelte';
	import { getWorkspaceRuntime } from './workspace-context.svelte';
	import TemplateSetup from '$lib/components/template/TemplateSetup.svelte';
	import LoadingState from '$lib/ui/LoadingState.svelte';
	import WorkspaceSkeleton from './WorkspaceSkeleton.svelte';
	let {
		children,
		requiresTemplate = false,
		requiresDocument = true
	}: { children?: Snippet; requiresTemplate?: boolean; requiresDocument?: boolean } = $props();
	const runtime = getWorkspaceRuntime();
	const viewer = useViewer();
	const templatePending = $derived(requiresTemplate && !viewer().templateReady);
	let mounted = $state(false);
	$effect(() => {
		if ((!requiresDocument || runtime.hostReady) && !runtime.paused && !templatePending)
			mounted = true;
	});
</script>

{#if templatePending}
	{#if !runtime.paused}
		<WorkspacePresentationReporter outcome="success" />
		<TemplateSetup getNavigationIntent={() => runtime.navigationIntent} />
	{/if}
{:else if mounted}
	<div hidden={runtime.paused} inert={runtime.paused}>{@render children?.()}</div>
{:else if !runtime.paused && !runtime.hostReady}
	<WorkspacePresentationReporter outcome={runtime.error ? 'error' : 'pending'} />
	{#if !runtime.error}
		<WorkspaceSkeleton label="Loading document viewer" />
	{:else}
		<LoadingState layout="workspace">
			<p role="alert" class="text-sm">{runtime.error}</p>
			<button class="text-sm underline" onclick={runtime.retry}>Try again</button>
		</LoadingState>
	{/if}
{/if}
