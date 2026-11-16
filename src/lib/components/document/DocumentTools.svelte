<script lang="ts">
	import UtilityRail from '$lib/components/chrome/UtilityRail.svelte';
	import {
		loadDocumentSearch,
		type DocumentToolControls,
		type SearchToolControls,
		type ToolState,
		type ToolStates
	} from './document-tools';
	import { loadComponent } from '$lib/auth/component-loader.svelte';
	import HelpModal from '$lib/components/ui/modal/HelpModal.svelte';
	import { helpContent, type HelpVariant } from '$lib/components/ui/modal/help-content';
	import type { HelpSession } from '$lib/components/ui/modal/help-session.svelte';
	import {
		getOptionalDocumentWorkspace,
		type DocumentWorkspace
	} from '$lib/document/runtime/workspace-context';
	import { getInteractionOwner } from '$lib/components/ui/interactions';
	let {
		active = true,
		isAdmin = false,
		helpVariant,
		helpReady,
		help,
		helpHosted = false,
		onDownload,
		downloadReason = null,
		downloadState,
		settingsHref,
		workspace,
		interactionOwner,
		onTools
	}: {
		active?: boolean;
		isAdmin?: boolean;
		helpVariant: HelpVariant;
		helpReady: boolean;
		help: HelpSession;
		helpHosted?: boolean;
		onDownload?: () => void;
		downloadReason?: string | null;
		downloadState?: ToolState;
		settingsHref?: string;
		workspace?: DocumentWorkspace;
		interactionOwner?: symbol;
		onTools?: (tools: DocumentToolControls) => () => void;
	} = $props();
	const contextWorkspace = getOptionalDocumentWorkspace();
	const contextOwner = getInteractionOwner();
	const document = $derived(workspace ?? contextWorkspace);
	const owner = $derived(interactionOwner ?? contextOwner);
	const documentAvailable = $derived(
		Boolean(
			active &&
			document?.viewer.pagesVisible &&
			!document.source.issue &&
			!document.renderer.error &&
			!document.viewer.preparationBlocked
		)
	);
	// The route or buyer shell owns automatic admission; the button can work before pages do.
	const helpEnabled = $derived(active && help.resolved);
	$effect(() => {
		if (!helpHosted && helpReady && documentAvailable) help.considerAutomatic();
	});
	$effect(() => {
		if (!active && !helpHosted) help.close();
	});
	function openHelp() {
		if (helpEnabled) help.openManually();
	}
	const search = loadComponent(loadDocumentSearch, () => active);
	const Search = $derived(search.component);
	let controls = $state.raw<SearchToolControls>();
	let desktop = $state<HTMLElement>();
	let mobile = $state<HTMLElement>();
	$effect(() => controls?.setRails(desktop, mobile));
	const states = $derived<ToolStates>({
		search: {
			applicability: 'present',
			// A visible disabled Search button does not hold back independent tools.
			display: search.failed ? 'failed' : 'ready',
			enabled: controls?.searchEnabled ?? false,
			retry: search.retry
		},
		download: downloadState ?? {
			applicability: onDownload ? 'present' : 'absent',
			display: 'ready',
			enabled: !downloadReason
		},
		settings: {
			applicability: settingsHref ? 'present' : 'absent',
			display: 'ready',
			enabled: true
		},
		help: { applicability: 'present', display: 'ready', enabled: helpEnabled }
	});
	$effect(() => {
		if (!onTools || !active) return;
		return onTools({
			owner,
			get searchOpen() {
				return controls?.searchOpen ?? false;
			},
			searchEnabled: controls?.searchEnabled ?? false,
			helpEnabled,
			states,
			onSearchToggle: (button) => controls?.onSearchToggle(button),
			onOpenHelp: openHelp,
			closePanel: (restore) => controls?.closePanel(restore),
			setRails: (first, second) => {
				desktop = first;
				mobile = second;
			}
		});
	});
</script>

{#if Search && document}
	<Search
		{active}
		workspace={document}
		interactionOwner={owner}
		onControls={(value) => {
			controls = value;
			return () => {
				if (controls === value) controls = undefined;
			};
		}}
	/>
{/if}
{#if !onTools}
	<UtilityRail
		{states}
		interactionOwner={owner}
		searchOpen={controls?.searchOpen ?? false}
		bind:desktopElement={desktop}
		bind:mobileElement={mobile}
		searchEnabled={controls?.searchEnabled ?? false}
		onSearchToggle={(button) => controls?.onSearchToggle(button)}
		{helpEnabled}
		helpLabel={helpContent[helpVariant].title}
		{onDownload}
		{downloadReason}
		{settingsHref}
		onOpenHelp={openHelp}
	/>
{/if}
{#if !helpHosted && helpEnabled && help.open}
	<HelpModal variant={helpVariant} {isAdmin} {help} onClose={() => help.close()} />
{/if}
