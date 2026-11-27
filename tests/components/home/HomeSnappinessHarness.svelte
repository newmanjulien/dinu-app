<script lang="ts">
	import SnappinessContext from '../viewer/SnappinessContext.svelte';
	import ContractsFrame from '../../../src/lib/components/workspace/ContractsFrame.svelte';
	import { untrack } from 'svelte';
	import type { StartupHome } from '../../../src/lib/auth/startup-data';
	import type { CsmState } from '../../support/csm-state.svelte';
	import type { StartupSetup } from '../../../src/lib/auth/startup-data';
	import {
		setWorkspaceLists,
		type WorkspaceLists
	} from '../../../src/lib/auth/workspace-lists.svelte';
	import {
		ContractsSearchSession,
		HOME_SEARCH_SETTLE_MS,
		setContractsSearch
	} from '../../../src/lib/components/workspace/contracts-search.svelte';
	let {
		state,
		startup,
		setup,
		lists,
		returning = false
	}: {
		state: CsmState;
		startup: StartupHome | null;
		setup: StartupSetup | null;
		lists?: WorkspaceLists;
		returning?: boolean;
	} = $props();
	untrack(() => {
		if (lists) setWorkspaceLists(lists);
	});
	const searchSession = new ContractsSearchSession();
	const search = setContractsSearch(() => searchSession);
	untrack(() => {
		if (returning) search.visited = true;
	});
	$effect(() => {
		const value = searchSession.value.trim();
		if (!value) {
			searchSession.query = '';
			return;
		}
		const timer = setTimeout(() => (searchSession.query = value), HOME_SEARCH_SETTLE_MS);
		return () => clearTimeout(timer);
	});
</script>

<SnappinessContext {state} startupHome={startup} deferCompanySetup startupSetup={setup}
	><ContractsFrame /></SnappinessContext
>
