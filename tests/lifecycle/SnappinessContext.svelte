<script lang="ts">
	import { setBuyerLinkCopyFeedback } from '../../src/lib/buyer/copy-feedback.svelte';
	import { setAccountContext } from '../../src/lib/auth/account-context.svelte';
	import { onDestroy, untrack, type Snippet } from 'svelte';
	import { HubSpotDeals, setHubSpotDeals } from '../../src/lib/hubspot-deals.svelte';
	import { setViewer, setViewerSession } from '../../src/lib/auth/viewer-session.svelte';
	import { setWorkspaceRuntime } from '../../src/lib/auth/workspace-context.svelte';
	import {
		setStartupData,
		setStartupHome,
		type StartupHome,
		type StartupData
	} from '../../src/lib/auth/startup-data';
	import {
		setTemplateAuthoringSession,
		type TemplateAuthoringSession
	} from '../../src/lib/playbook/template-authoring-session.svelte';
	import {
		setDocumentResources,
		type DocumentResources
	} from '../../src/lib/document/runtime/resources.svelte';
	import { setDocumentLayoutProfiles } from '../../src/lib/document/runtime/layout-context.svelte';
	import {
		setDocumentWorkspace,
		type DocumentWorkspace
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
		startupHome,
		children
	}: {
		state: CsmState;
		authoring?: TemplateAuthoringSession;
		resources?: DocumentResources;
		workspace?: DocumentWorkspace;
		startup?: StartupData | null;
		startupHome?: StartupHome | null;
		children: Snippet;
	} = $props();
	const copyFeedback = setBuyerLinkCopyFeedback();
	onDestroy(() => copyFeedback.destroy());
	const accountContext = setAccountContext();
	accountContext.authenticated = true;
	accountContext.loading = false;
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
					quotes: {
						installationId: null,
						epoch: 0,
						installed: false,
						connected: false,
						enabled: false,
						pushEnabled: false
					},
					status: 'uninstalled',
					enabled: false,
					configured: false,
					accountId: null,
					connectionId: null,
					shared: false,
					removal: null,
					installedAt: null,
					companyReadGranted: false
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
	setStartupHome(() => startupHome ?? null);
	untrack(() => {
		if (authoring) setTemplateAuthoringSession(authoring);
		if (resources) {
			setDocumentResources(resources);
			setDocumentLayoutProfiles(resources.profiles);
		}
		if (workspace) setDocumentWorkspace(workspace);
	});
</script>

{@render children()}
