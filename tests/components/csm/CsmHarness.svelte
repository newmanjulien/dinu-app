<script lang="ts">
	import { untrack } from 'svelte';
	import WorkspaceShell from '../../../src/lib/auth/WorkspaceShell.svelte';
	import WorkspacePresentationReporter from '../../../src/lib/auth/WorkspacePresentationReporter.svelte';
	import TemplateSetup from '../../../src/lib/components/template/TemplateSetup.svelte';
	import { setViewer, setViewerSession } from '../../../src/lib/auth/viewer-session.svelte';
	import type { CsmState } from '../../support/csm-state.svelte';
	let { state }: { state: CsmState } = $props();
	setViewer(() => state.viewer);
	untrack(() => setViewerSession(state.session));
</script>

<WorkspaceShell>
	<WorkspacePresentationReporter outcome={state.outcome} revision={state.revision} />
	{#if state.form}<TemplateSetup getNavigationIntent={() => 0} />{/if}
</WorkspaceShell>
