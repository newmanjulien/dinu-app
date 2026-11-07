<script lang="ts">
	import SnappinessContext from './SnappinessContext.svelte';
	import AdminWorkspace from '../../src/lib/components/workspace/AdminWorkspace.svelte';
	import type { AdminAuthoringSession } from '../../src/lib/playbook/admin-authoring-session.svelte';
	import type { CsmState } from './csm-state.svelte';
	let { state, authoring }: { state: CsmState; authoring: AdminAuthoringSession } = $props();
</script>

<SnappinessContext {state} {authoring}><AdminWorkspace /></SnappinessContext>
