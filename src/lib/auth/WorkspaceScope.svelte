<script lang="ts">
	import {
		WorkspaceReadSnapshots,
		setWorkspaceReadSnapshots
	} from './workspace-read-snapshots.svelte';
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
	import { WorkspaceDestinations, setWorkspaceDestinations } from './workspace-context.svelte';
	import { preloadDestination, warmDocumentDestination } from './destination-code';
	import { TemplateSource, setTemplateSource } from '$lib/playbook/template-source.svelte';
	import {
		TemplateAuthoringSession,
		setTemplateAuthoringSession
	} from '$lib/playbook/template-authoring-session.svelte';
	let { viewer, children }: { viewer: Viewer; children: Snippet } = $props();
	setViewer(() => viewer);
	const account = useViewerSession();
	const client = useConvexClient();
	const reads = setWorkspaceReadSnapshots(
		untrack(
			() =>
				new WorkspaceReadSnapshots(
					{
						profileId: viewer.profile.id,
						membershipId: viewer.membership.id,
						companyId: viewer.company.id
					},
					account.userId!
				)
		)
	);
	untrack(() => reads.configure(viewer.permissions.manageMembers, !viewer.company.deletionPending));
	// Start scoped disk reads as soon as the verified workspace exists. None gate rendering.
	if (typeof indexedDB !== 'undefined') {
		void reads.hydrate('contracts');
		void reads.hydrate('buyerLinks');
		void reads.hydrateDirectory('contracts');
		void reads.hydrateDirectory('buyerLinks');
	}
	$effect(() => {
		const manageMembers = viewer.permissions.manageMembers;
		const deleting = viewer.company.deletionPending;
		untrack(() => reads.configure(manageMembers, !deleting));
	});
	const hubspotConnection = useReadQuery(
		api.hubspotConnections.status,
		() =>
			account.workspaceAdmitted &&
			!account.blocked &&
			!account.closing &&
			!viewer.company.deletionPending
				? { membershipId: viewer.membership.id }
				: 'skip',
		() => account.transportGeneration
	);
	const hubspot = setHubSpotDeals(
		new HubSpotDeals({
			client,
			membershipId: untrack(() => viewer.membership.id),
			connection: hubspotConnection,
			generation: () => account.transportGeneration,
			identity: () =>
				account.workspaceAdmitted &&
				!account.blocked &&
				!account.closing &&
				!viewer.company.deletionPending
					? JSON.stringify([
							account.preparedSessionId,
							account.userId,
							viewer.membership.id,
							viewer.company.id
						])
					: null
		})
	);
	$effect(() => {
		const identity = hubspot.identity;
		void hubspot.connection.data;
		void hubspot.connection.isLoading;
		void hubspot.connection.error;
		void hubspot.connection.rejected;
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
					onSaved: (notice) => {
						reads.contractChanged(notice.id, notice.name);
						void reads.syncDirectory(client);
					},
					onDeleted: (id) => {
						reads.contractChanged(id, undefined, true);
						void reads.syncDirectory(client);
					},
					onRenamed: (id, name) => {
						reads.contractChanged(id, name);
						void reads.syncDirectory(client);
					}
				})
		)
	);
	const templateSource = setTemplateSource(
		new TemplateSource(
			client,
			untrack(() => viewer.membership.id),
			reads.storage
		)
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
	const destinations = setWorkspaceDestinations(
		new WorkspaceDestinations({
			available: () =>
				account.workspaceAdmitted &&
				!account.blocked &&
				!account.closing &&
				!viewer.company.deletionPending,
			acquire: (path) => {
				const saved = /^\/contracts\/([^/]+)(?:\/settings)?$/.exec(path);
				if (saved && saved[1] !== 'new') {
					if (path.endsWith('/settings')) return sessions.retainMetadata(saved[1]).release;
					void preloadDestination(path).catch(() => {});
					warmDocumentDestination('saved');
					return sessions.acquire(saved[1]).release;
				}
				if (path === '/contracts/new' && viewer.templateReady && viewer.instructionsReady) {
					void preloadDestination(path).catch(() => {});
					warmDocumentDestination('new');
					const releaseSource = templateSource.retain();
					const releaseOpening = hubspot.retainOpening();
					return () => {
						releaseOpening();
						releaseSource();
					};
				}
				if (
					(path === '/template' || path === '/template/buyers') &&
					viewer.templateReady &&
					viewer.membership.role === 'admin'
				) {
					void preloadDestination(path).catch(() => {});
					warmDocumentDestination('template');
					return (path === '/template/buyers' ? buyerAuthoring : authoring).retainReads();
				}
			}
		})
	);
	onMount(() => {
		const stopDestinations = destinations.mount();
		sessions.start();
		authoring.start();
		buyerAuthoring.start();
		return stopDestinations;
	});
	onDestroy(() => {
		destinations.clear();
		reads.destroy();
		hubspot.destroy();
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
			templateSource.configure(available && !frozen && !account.closing, generation);
			authoring.configure(available && admin, frozen, generation);
			buyerAuthoring.configure(available && admin, frozen, generation);
		});
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
