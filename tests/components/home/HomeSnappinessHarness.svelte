<script lang="ts">
	import SnappinessContext from '../viewer/SnappinessContext.svelte';
	import ContractsFrame from '../../../src/lib/components/workspace/ContractsFrame.svelte';
	import { untrack } from 'svelte';
	import type { StartupHome } from '../../../src/lib/auth/startup-data';
	import type { CsmState } from '../../support/csm-state.svelte';
	import type { StartupSetup } from '../../../src/lib/auth/startup-data';
	import {
		setWorkspaceReadSnapshots,
		type WorkspaceReadSnapshots
	} from '../../../src/lib/auth/workspace-read-snapshots.svelte';
	import { setContractsSearch } from '../../../src/lib/components/workspace/contracts-search.svelte';
	let {
		state,
		startup,
		setup,
		reads,
		returning = false
	}: {
		state: CsmState;
		startup: StartupHome | null;
		setup: StartupSetup | null;
		reads?: WorkspaceReadSnapshots;
		returning?: boolean;
	} = $props();
	untrack(() => {
		if (reads) setWorkspaceReadSnapshots(reads);
	});
	const search = setContractsSearch();
	untrack(() => {
		if (returning) search.visited = true;
	});
	$effect(() => {
		const value = search.value.trim();
		const timer = setTimeout(() => (search.query = value), 200);
		return () => clearTimeout(timer);
	});
</script>

<SnappinessContext {state} startupHome={startup} deferCompanySetup startupSetup={setup}
	><ContractsFrame /></SnappinessContext
>
