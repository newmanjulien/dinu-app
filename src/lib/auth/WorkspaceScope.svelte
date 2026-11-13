<script lang="ts">
	import { useReadQuery } from '$lib/auth/read-query.svelte';
	import { setViewer, useViewerSession, type Viewer } from './viewer-session.svelte';
	import { onMount, onDestroy, untrack, type Snippet } from 'svelte';
	import { useConvexClient } from 'convex-svelte';
	import { api } from '../../convex/_generated/api';
	import { HubSpotDeals, setHubSpotDeals } from '$lib/hubspot-deals.svelte';
	import { getContractSnapshotCache } from '$lib/contract/snapshot-cache';
	import { ContractEditors, setContractEditors } from '$lib/contract/editors.svelte';
	import {
		WorkspaceFeedback,
		setWorkspaceFeedback
	} from '$lib/components/chrome/workspace-feedback.svelte';
	import { beforeNavigate } from '$app/navigation';
	import { TemplateSource } from '$lib/playbook/template-source.svelte';
	import {
		TemplateAuthoringSession,
		setTemplateAuthoringSession
	} from '$lib/playbook/template-authoring-session.svelte';
	let { viewer, children }: { viewer: Viewer; children: Snippet } = $props();
	setViewer(() => viewer);
	const account = useViewerSession();
	const client = useConvexClient();
	const hubspotConnection = useReadQuery(api.hubspotConnections.status, () =>
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
	const templateSource = new TemplateSource(
		client,
		untrack(() => viewer.membership.id)
	);
	const authoring = setTemplateAuthoringSession(
		untrack(
			() =>
				new TemplateAuthoringSession({
					templateSource,
					client,
					membershipId: viewer.membership.id,
					companyId: viewer.company.id,
					registerEditor: account.registerEditor
				})
		)
	);
	const buyerAuthoring = setTemplateAuthoringSession(
		untrack(
			() =>
				new TemplateAuthoringSession({
					templateSource,
					client,
					membershipId: viewer.membership.id,
					companyId: viewer.company.id,
					audience: 'buyer',
					registerEditor: account.registerEditor
				})
		),
		'buyer'
	);
	const authoringFeedback = feedback.registerAuthoring();
	onMount(() => {
		sessions.start();
		authoring.start();
		buyerAuthoring.start();
	});
	onDestroy(() => {
		hubspot.destroy();
		authoringFeedback.release();
		authoring.destroy();
		buyerAuthoring.destroy();
		templateSource.destroy();
		feedback.destroy();
		sessions.destroy();
	});
	$effect(() => {
		const available = !viewer.company.deletionPending;
		const admin = viewer.membership.role === 'admin';
		const frozen = account.blocked;
		const generation = account.transportGeneration;
		untrack(() => {
			sessions.configure(available, frozen, generation);
			templateSource.configure(available && admin && !frozen, generation);
			authoring.configure(available && admin, frozen, generation);
			buyerAuthoring.configure(available && admin, frozen, generation);
		});
	});
	let latestAuthoringCompletion = $state.raw<TemplateAuthoringSession['completion']>(null);
	$effect(() => {
		const completion = authoring.completion;
		if (completion) untrack(() => (latestAuthoringCompletion = completion));
	});
	$effect(() => {
		const completion = buyerAuthoring.completion;
		if (completion) untrack(() => (latestAuthoringCompletion = completion));
	});
	$effect(() => {
		const completion = latestAuthoringCompletion;
		const pending = authoring.pending || buyerAuthoring.pending;
		untrack(() => authoringFeedback.update(completion, pending));
	});
	beforeNavigate((navigation) => {
		if (account.blocked && !account.closing && !navigation.willUnload) navigation.cancel();
	});
	function warnBeforeUnload(event: BeforeUnloadEvent) {
		if ((!sessions.pending && !authoring.pending && !buyerAuthoring.pending) || account.closing)
			return;
		event.preventDefault();
		event.returnValue = '';
	}
</script>

<svelte:window onbeforeunload={warnBeforeUnload} />
{@render children()}
