<script lang="ts">
	import { untrack } from 'svelte';
	import WorkspaceShell from '../../src/lib/auth/WorkspaceShell.svelte';
	import WorkspacePresentationReporter from '../../src/lib/auth/WorkspacePresentationReporter.svelte';
	import BaselineSetup from '../../src/lib/components/template/BaselineSetup.svelte';
	import { setViewer, setViewerSession } from '../../src/lib/auth/viewer-session.svelte';
	import type { CsmState } from './csm-state.svelte';
	let { state }: { state: CsmState } = $props();
	setViewer(() => state.viewer);
	untrack(() => setViewerSession(state.session));
</script>

<WorkspaceShell>
	<WorkspacePresentationReporter outcome={state.outcome} revision={state.revision} />
	{#if state.form}<BaselineSetup getNavigationIntent={() => 0} />{/if}
</WorkspaceShell>
