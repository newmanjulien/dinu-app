<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { useConvexClient } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import { HelpSession, type HelpPolicy } from '$lib/components/ui/modal/help-session.svelte';
	import DocumentTools from '$lib/components/document/DocumentTools.svelte';
	import type { DocumentWorkspace } from '$lib/document/runtime/workspace-context';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import type { HelpVariant } from '$lib/components/ui/modal/help-content';
	import { useHubSpotDeals } from '$lib/hubspot-deals.svelte';
	import type { ToolState } from '$lib/components/document/document-tools';
	let {
		helpVariant,
		helpReady,
		help = new HelpSession(),
		helpHosted = false,
		onDownload,
		downloadReason = null,
		settingsHref,
		workspace,
		interactionOwner
	}: {
		helpVariant: Exclude<HelpVariant, 'buyer'>;
		helpReady: boolean;
		help?: HelpSession;
		helpHosted?: boolean;
		onDownload?: () => void;
		downloadReason?: string | null;
		settingsHref?: string;
		workspace?: DocumentWorkspace;
		interactionOwner?: symbol;
	} = $props();
	const accountViewer = useViewer();
	const session = useViewerSession();
	const client = useConvexClient();
	const connection = useHubSpotDeals()?.connection;
	const downloadState = $derived<ToolState | undefined>(
		helpVariant !== 'rep'
			? undefined
			: connection?.error
				? {
						applicability: 'present',
						display: 'failed',
						enabled: false,
						retry: () => connection.retry?.()
					}
				: !connection?.data || connection.isLoading
					? { applicability: 'pending', display: 'pending' }
					: {
							applicability: connection.data.quotes?.installed ? 'present' : 'absent',
							display: 'ready',
							enabled: Boolean(onDownload) && !downloadReason
						}
	);
	onDestroy(() => {
		if (!helpHosted) help.destroy();
	});
	$effect(() => {
		if (helpHosted) return;
		let policy: HelpPolicy = { kind: 'manual' };
		if (helpVariant === 'rep') {
			const account = accountViewer();
			const identity = account.profile.id;
			const generation = session.transportGeneration;
			policy = {
				kind: 'preference',
				confirmation: 'subscription',
				identity,
				hidden: account.helpPreferences.rep,
				save: (hidden) => client.mutation(api.profiles.setHelpHidden, { variant: 'rep', hidden }),
				current: () =>
					accountViewer().profile.id === identity &&
					session.transportGeneration === generation &&
					!session.closing
			};
		}
		untrack(() => help.configure(policy));
	});
</script>

<DocumentTools
	{helpVariant}
	{helpReady}
	{help}
	{helpHosted}
	{downloadState}
	{onDownload}
	{downloadReason}
	{settingsHref}
	{workspace}
	{interactionOwner}
	isAdmin={helpVariant === 'rep' && accountViewer().membership.role === 'admin'}
/>
