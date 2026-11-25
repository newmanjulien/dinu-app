<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { HelpSession } from '$lib/components/ui/modal/help-session.svelte';
	import DocumentTools from '$lib/components/document/DocumentTools.svelte';
	import type { DocumentWorkspace } from '$lib/document/runtime/workspace-context';
	import type { TemplateHelpVariant } from '$lib/components/ui/modal/help-content';
	import { useHubSpotDeals } from '$lib/hubspot-deals.svelte';
	import type { ToolState } from '$lib/components/document/document-tools';
	let {
		kind,
		helpVariant,
		helpReady,
		help,
		helpHosted = false,
		onDownload,
		downloadReason = null,
		settingsHref,
		workspace,
		interactionOwner
	}: {
		kind: 'saved' | 'template';
		helpVariant?: TemplateHelpVariant;
		helpReady: boolean;
		help?: HelpSession;
		helpHosted?: boolean;
		onDownload?: () => void;
		downloadReason?: string | null;
		settingsHref?: string;
		workspace?: DocumentWorkspace;
		interactionOwner?: symbol;
	} = $props();
	const connection = useHubSpotDeals()?.connection;
	const downloadState = $derived<ToolState | undefined>(
		kind !== 'saved'
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
	const ownedHelp = new HelpSession();
	const activeHelp = $derived(help ?? ownedHelp);
	onDestroy(() => ownedHelp.destroy());
	$effect(() => {
		if (help || !helpVariant) return;
		const variant = helpVariant;
		untrack(() => ownedHelp.configure({ kind: 'manual', variant }));
	});
</script>

<DocumentTools
	{helpReady}
	help={activeHelp}
	{helpHosted}
	{downloadState}
	{onDownload}
	{downloadReason}
	{settingsHref}
	{workspace}
	{interactionOwner}
/>
