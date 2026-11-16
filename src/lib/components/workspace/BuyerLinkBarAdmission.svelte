<script lang="ts">
	import type { Id } from '../../../convex/_generated/dataModel';
	import { api } from '../../../convex/_generated/api';
	import type { useReadQuery } from '$lib/auth/read-query.svelte';
	import type { DocumentWorkspace } from '$lib/document/runtime/workspace-context';
	import BuyerLinkBar from '$lib/buyer/BuyerLinkBar.svelte';

	let {
		id,
		latest,
		workspace,
		available,
		interactionAdmitted
	}: {
		id: Id<'savedContracts'>;
		latest: ReturnType<typeof useReadQuery<typeof api.buyerLinks.latest>>;
		workspace: DocumentWorkspace;
		available: boolean;
		interactionAdmitted: boolean;
	} = $props();
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
	const ready = $derived(interactionAdmitted && available && firstPagesSeen && statusSeen);
</script>

{#if ready}<BuyerLinkBar {id} {latest} />{/if}
