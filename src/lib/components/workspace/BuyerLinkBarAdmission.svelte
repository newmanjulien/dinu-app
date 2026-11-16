<script lang="ts">
	import type { Id } from '../../../convex/_generated/dataModel';
	import { api } from '../../../convex/_generated/api';
	import type { useReadQuery } from '$lib/auth/read-query.svelte';
	import type { DocumentWorkspace } from '$lib/document/runtime/workspace-context';
	import BuyerLinkBar from '$lib/buyer/BuyerLinkBar.svelte';
	import type { BuyerLinkBarVisit } from '$lib/buyer/bar-visit.svelte';
	import { useConvexClient } from 'convex-svelte';

	let {
		id,
		visit,
		latest,
		workspace,
		available,
		interactionAdmitted
	}: {
		id: Id<'savedContracts'>;
		visit?: BuyerLinkBarVisit;
		latest: ReturnType<typeof useReadQuery<typeof api.buyerLinks.latest>>;
		workspace: DocumentWorkspace;
		available: boolean;
		interactionAdmitted: boolean;
	} = $props();
	const client = useConvexClient();
	let firstPagesSeen = $state(false);
	let statusSeen = $state(false);
	$effect(() => {
		const ready = workspace.viewer.firstPagesReady;
		if (ready && workspace.source.renderSource && ready.source === workspace.source.renderSource)
			firstPagesSeen = true;
	});
	$effect(() => {
		if (!available || (latest.data === undefined && !latest.error && !latest.isLoading))
			statusSeen = false;
		else if (latest.data !== undefined || latest.error) statusSeen = true;
	});
	$effect(() => {
		if (
			interactionAdmitted &&
			available &&
			firstPagesSeen &&
			statusSeen &&
			(latest.data === null || latest.error) &&
			visit
		)
			visit.claim(client);
	});
	const ready = $derived(interactionAdmitted && available && firstPagesSeen && visit?.shown);
</script>

{#if ready}<BuyerLinkBar {id} {latest} />{/if}
