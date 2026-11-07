<script lang="ts">
	import { setViewer, useViewerSession, type Viewer } from './viewer-session.svelte';
	import { onMount, onDestroy, untrack, type Snippet } from 'svelte';
	import { useConvexClient, useQuery } from 'convex-svelte';
	import { api } from '../../convex/_generated/api';
	import { HubSpotDeals, setHubSpotDeals } from '$lib/hubspot-deals.svelte';
	import { getContractSnapshotCache } from '$lib/contract/snapshot-cache';
	import { ContractEditors, setContractEditors } from '$lib/contract/editors.svelte';
	import {
		WorkspaceFeedback,
		setWorkspaceFeedback
	} from '$lib/components/chrome/workspace-feedback.svelte';
	import { beforeNavigate } from '$app/navigation';
	import {
		AdminAuthoringSession,
		setAdminAuthoringSession
	} from '$lib/playbook/admin-authoring-session.svelte';
	let { viewer, children }: { viewer: Viewer; children: Snippet } = $props();
	setViewer(() => viewer);
	const account = useViewerSession();
	const client = useConvexClient();
	const hubspotConnection = useQuery(api.hubspotConnections.status, () =>
		account.workspaceAdmitted &&
		!account.blocked &&
		!account.closing &&
		!viewer.company.deletionPending
			? { membershipId: viewer.membership.id }
			: 'skip'
	);
	const hubspot = setHubSpotDeals(
		new HubSpotDeals({
			client,
			membershipId: untrack(() => viewer.membership.id),
			connection: hubspotConnection,
			identity: () =>
				account.workspaceAdmitted &&
				!account.blocked &&
				!account.closing &&
				!viewer.company.deletionPending
					? JSON.stringify([
							account.preparedSessionId,
							account.userId,
							account.transportGeneration,
							viewer.membership.id,
							viewer.company.id
						])
					: null
		})
	);
	$effect(() => {
		const identity = hubspot.identity;
		untrack(() => hubspot.align(identity));
	});
	const feedback: WorkspaceFeedback = setWorkspaceFeedback(
		new WorkspaceFeedback(() => sessions.notices)
	);
	const sessions: ContractEditors = setContractEditors(
		untrack(
			() =>
				new ContractEditors({
					userId: account.userId!,
					membershipId: viewer.membership.id,
					companyId: viewer.company.id,
					client,
					get cache() {
						return getContractSnapshotCache(client);
					},
					registerEditor: account.registerEditor,
					onSaved: feedback.contractSaved,
					onDeleted: feedback.contractDeleted,
					onRenamed: feedback.contractRenamed
				})
		)
	);
	const authoring = setAdminAuthoringSession(
		untrack(
			() =>
				new AdminAuthoringSession({
					client,
					membershipId: viewer.membership.id,
					companyId: viewer.company.id,
					registerEditor: account.registerEditor
				})
		)
	);
	const authoringFeedback = feedback.registerAuthoring();
	onMount(() => {
		sessions.start();
		authoring.start();
	});
	onDestroy(() => {
		hubspot.destroy();
		authoringFeedback.release();
		authoring.destroy();
		feedback.destroy();
		sessions.destroy();
	});
	$effect(() => {
		const available = !viewer.company.deletionPending;
		const frozen = account.blocked;
		const generation = account.transportGeneration;
		untrack(() => {
			sessions.configure(available, frozen, generation);
			authoring.configure(available, frozen, generation);
		});
	});
	$effect(() => {
		const completion = authoring.completion;
		const pending = authoring.pending;
		untrack(() => authoringFeedback.update(completion, pending));
	});
	beforeNavigate((navigation) => {
		if (account.blocked && !account.closing && !navigation.willUnload) navigation.cancel();
	});
	function warnBeforeUnload(event: BeforeUnloadEvent) {
		if ((!sessions.pending && !authoring.pending) || account.closing) return;
		event.preventDefault();
		event.returnValue = '';
	}
</script>

<svelte:window onbeforeunload={warnBeforeUnload} />
{@render children()}
