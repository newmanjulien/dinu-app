<script lang="ts">
	import WorkspaceFrame from '$lib/auth/WorkspaceFrame.svelte';
	import RequireAccount from '$lib/auth/RequireAccount.svelte';
	import WorkspaceBoundary from '$lib/auth/WorkspaceBoundary.svelte';
	import { page } from '$app/state';
	import {
		ContractsSearchSession,
		HOME_SEARCH_SETTLE_MS,
		setContractsSearch
	} from '$lib/components/workspace/contracts-search.svelte';
	let { children } = $props();
	const session = $derived(
		page.route.id === '/(workspace)/contracts' ? new ContractsSearchSession() : undefined
	);
	setContractsSearch(() => session);
	$effect(() => {
		const current = session;
		if (!current) return;
		const value = current.value.trim();
		if (!value) {
			current.query = '';
			return;
		}
		const timer = setTimeout(() => (current.query = value), HOME_SEARCH_SETTLE_MS);
		return () => clearTimeout(timer);
	});
</script>

<WorkspaceFrame
	><RequireAccount><WorkspaceBoundary>{@render children()}</WorkspaceBoundary></RequireAccount
	></WorkspaceFrame
>
