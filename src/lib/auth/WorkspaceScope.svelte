<script lang="ts">
	import { setViewer, useViewerSession, type Viewer } from './viewer-session.svelte';
	import { onMount, onDestroy, untrack, type Snippet } from 'svelte';
	import { useConvexClient } from 'convex-svelte';
	import { getContractSnapshotCache } from '$lib/contract/snapshot-cache';
	import { ContractSessions, setContractSessions } from '$lib/contract/sessions.svelte';
	import { beforeNavigate } from '$app/navigation';
	let { viewer, children }: { viewer: Viewer; children: Snippet } = $props();
	setViewer(() => viewer);
	const account = useViewerSession();
	const client = useConvexClient();
	const sessions = setContractSessions(
		untrack(
			() =>
				new ContractSessions({
					userId: account.userId!,
					membershipId: viewer.membership.id,
					companyId: viewer.company.id,
					client,
					get cache() {
						return getContractSnapshotCache(client);
					},
					registerEditor: account.registerEditor
				})
		)
	);
	onMount(() => sessions.start());
	onDestroy(() => sessions.destroy());
	$effect(() => {
		const available = !viewer.company.deletionPending;
		const frozen = account.blocked;
		const generation = account.transportGeneration;
		untrack(() => sessions.configure(available, frozen, generation));
	});
	beforeNavigate((navigation) => {
		if (account.blocked && !account.closing && !navigation.willUnload) navigation.cancel();
	});
	function warnBeforeUnload(event: BeforeUnloadEvent) {
		if (!sessions.pending || account.closing) return;
		event.preventDefault();
		event.returnValue = '';
	}
</script>

<svelte:window onbeforeunload={warnBeforeUnload} />
{@render children()}
