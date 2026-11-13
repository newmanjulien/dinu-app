<script lang="ts">
	import SnappinessContext from '../viewer/SnappinessContext.svelte';
	import TemplateWorkspace from '../../../src/lib/components/workspace/TemplateWorkspace.svelte';
	import type { TemplateAuthoringSession } from '../../../src/lib/playbook/template-authoring-session.svelte';
	import type { CsmState } from '../../support/csm-state.svelte';
	let { state, authoring }: { state: CsmState; authoring: TemplateAuthoringSession } = $props();
</script>

<SnappinessContext {state} {authoring}><TemplateWorkspace /></SnappinessContext>
