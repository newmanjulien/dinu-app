<script lang="ts">
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { getWorkspaceRuntime } from '$lib/auth/workspace-context.svelte';
	import TemplateSetup from '$lib/components/template/TemplateSetup.svelte';

	const runtime = getWorkspaceRuntime();
</script>

{#if !runtime.paused}
	<WorkspacePresentationReporter outcome="success" />
	<TemplateSetup getNavigationIntent={() => runtime.navigationIntent} />
{/if}
