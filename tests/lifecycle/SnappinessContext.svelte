<script lang="ts">
	import { onDestroy, untrack, type Snippet } from 'svelte';
	import { HubSpotDeals, setHubSpotDeals } from '../../src/lib/hubspot-deals.svelte';
	import { setViewer, setViewerSession } from '../../src/lib/auth/viewer-session.svelte';
	import { setWorkspaceRuntime } from '../../src/lib/auth/workspace-context.svelte';
	import { setStartupData, type StartupData } from '../../src/lib/auth/startup-data';
	import {
		setAdminAuthoringSession,
		type AdminAuthoringSession
	} from '../../src/lib/playbook/admin-authoring-session.svelte';
	import {
		setDocumentResources,
		type DocumentResources
	} from '../../src/lib/document/runtime/resources.svelte';
	import { setContractLayoutProfiles } from '../../src/lib/document/runtime/layout-context.svelte';
	import {
		setContractWorkspace,
		type ContractWorkspace
	} from '../../src/lib/document/runtime/workspace-context';
	import {
		InteractionController,
		setInteractionController
	} from '../../src/lib/components/ui/interactions';
	import {
		WorkspaceFeedback,
		setWorkspaceFeedback
	} from '../../src/lib/components/chrome/workspace-feedback.svelte';
	import type { CsmState } from './csm-state.svelte';
	let {
		state,
		authoring,
		resources,
		workspace,
		startup,
		children
	}: {
		state: CsmState;
		authoring?: AdminAuthoringSession;
		resources?: DocumentResources;
		workspace?: ContractWorkspace;
		startup?: StartupData | null;
		children: Snippet;
	} = $props();
	setViewer(() => state.viewer);
	const hubspot = setHubSpotDeals(
		new HubSpotDeals({
			client: {
				action: async () => {
					throw new Error('HubSpot is not installed in this fixture.');
				}
			},
			membershipId: untrack(() => state.viewer.membership.id),
			connection: {
				data: {
					status: 'uninstalled',
					enabled: false,
					configured: false,
					accountId: null,
					installedAt: null
				},
				error: undefined
			},
			identity: () => state.session.preparedSessionId ?? null
		})
	);
	onDestroy(() => hubspot.destroy());
	untrack(() => setViewerSession(state.session));
	setWorkspaceRuntime({
		hostReady: true,
		paused: false,
		error: '',
		navigationIntent: 0,
		retry() {}
	});
	setInteractionController(new InteractionController());
	const feedback = setWorkspaceFeedback(new WorkspaceFeedback(() => []));
	onDestroy(() => feedback.destroy());
	setStartupData(() => startup ?? null);
	untrack(() => {
		if (authoring) setAdminAuthoringSession(authoring);
		if (resources) {
			setDocumentResources(resources);
			setContractLayoutProfiles(resources.profiles);
		}
		if (workspace) setContractWorkspace(workspace);
	});
</script>

{@render children()}
