<script lang="ts">
	import WorkspaceFrame from '$lib/auth/WorkspaceFrame.svelte';
	import RequireAccount from '$lib/auth/RequireAccount.svelte';
	import WorkspaceBoundary from '$lib/auth/WorkspaceBoundary.svelte';
	import { setContractsSearch } from '$lib/components/workspace/contracts-search.svelte';
	let { children } = $props();
	const contractsSearch = setContractsSearch();
	$effect(() => {
		const value = contractsSearch.value.trim();
		const timer = setTimeout(() => (contractsSearch.query = value), 200);
		return () => clearTimeout(timer);
	});
</script>

<WorkspaceFrame
	><RequireAccount><WorkspaceBoundary>{@render children()}</WorkspaceBoundary></RequireAccount
	></WorkspaceFrame
>
