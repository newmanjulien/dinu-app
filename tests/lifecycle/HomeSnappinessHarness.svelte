<script lang="ts">
	import SnappinessContext from './SnappinessContext.svelte';
	import Home from '../../src/lib/components/workspace/Home.svelte';
	import type { StartupData } from '../../src/lib/auth/startup-data';
	import type { CsmState } from './csm-state.svelte';
	let { state, startup }: { state: CsmState; startup: StartupData } = $props();
</script>

<SnappinessContext {state} {startup}><Home /></SnappinessContext>
