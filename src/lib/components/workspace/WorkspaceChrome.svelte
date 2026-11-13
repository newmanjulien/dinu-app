<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { useConvexClient } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import { HelpSession, type HelpPolicy } from '$lib/components/ui/modal/help-session.svelte';
	import DocumentTools from '$lib/components/document/DocumentTools.svelte';
	import { getWorkspaceFeedback } from '$lib/components/chrome/workspace-feedback.svelte';
	import { getDocumentWorkspace } from '$lib/document/runtime/workspace-context';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import type { HelpVariant } from '$lib/components/ui/modal/help-content';
	import type { OperationStatus } from '$lib/components/chrome/operation-status';
	let {
		feedback = null,
		helpVariant,
		helpReady,
		help = new HelpSession(),
		onDownload,
		downloadReason = null,
		settingsHref
	}: {
		feedback?: OperationStatus | null;
		helpVariant: Exclude<HelpVariant, 'buyer'>;
		helpReady: boolean;
		help?: HelpSession;
		onDownload?: () => void;
		downloadReason?: string | null;
		settingsHref?: string;
	} = $props();
	const { source, renderer, viewer } = getDocumentWorkspace();
	onDestroy(
		getWorkspaceFeedback().registerDocument({
			get feedback() {
				return feedback;
			},
			get renderPending() {
				return Boolean(viewer.displayedSnapshot && renderer.pending);
			},
			get renderError() {
				return viewer.displayedSnapshot ? renderer.error : null;
			},
			get sourceStale() {
				return Boolean(viewer.displayedSnapshot && source.issue);
			},
			get onRetryRender() {
				return viewer.retry;
			}
		})
	);
	const accountViewer = useViewer();
	const session = useViewerSession();
	const client = useConvexClient();
	$effect(() => {
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
	{onDownload}
	{downloadReason}
	{settingsHref}
	isAdmin={helpVariant === 'rep' && accountViewer().membership.role === 'admin'}
/>
