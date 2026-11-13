<script lang="ts">
	import SnappinessContext from '../viewer/SnappinessContext.svelte';
	import Contracts from '../../../src/lib/components/workspace/Contracts.svelte';
	import type { StartupHome } from '../../../src/lib/auth/startup-data';
	import type { CsmState } from '../../support/csm-state.svelte';
	let { state, startup }: { state: CsmState; startup: StartupHome } = $props();
</script>

<SnappinessContext {state} startupHome={startup} deferCompanySetup><Contracts /></SnappinessContext>
