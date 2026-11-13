<script lang="ts">
	import { recordColdStart } from '$lib/document/runtime/render-perf';
	import { DocumentSearchSession } from '$lib/document/search/search-session.svelte';
	import UtilityRail from '$lib/components/chrome/UtilityRail.svelte';
	import type { DocumentToolControls } from './document-tools';
	import UtilityPanel, { type UtilityPanelName } from './UtilityPanel.svelte';
	import DocumentSearchPanel from '$lib/components/search/DocumentSearchPanel.svelte';
	import HelpModal from '$lib/components/ui/modal/HelpModal.svelte';
	import { helpContent, type HelpVariant } from '$lib/components/ui/modal/help-content';
	import type { HelpSession } from '$lib/components/ui/modal/help-session.svelte';
	import { onMount, tick } from 'svelte';
	import { getDocumentWorkspace } from '$lib/document/runtime/workspace-context';
	import { getInteractionController, getInteractionOwner } from '$lib/components/ui/interactions';
	const interactions = getInteractionController();
	const owner = getInteractionOwner();
	let {
		active = true,
		isAdmin = false,
		helpVariant,
		helpReady,
		help,
		onDownload,
		downloadReason = null,
		settingsHref,
		onTools
	}: {
		active?: boolean;
		isAdmin?: boolean;
		helpVariant: HelpVariant;
		helpReady: boolean;
		help: HelpSession;
		onDownload?: () => void;
		downloadReason?: string | null;
		settingsHref?: string;
		onTools?: (tools: DocumentToolControls) => () => void;
	} = $props();
	const { source, renderer, viewer } = getDocumentWorkspace();
	const documentAvailable = $derived(
		active && viewer.pagesVisible && !source.issue && !renderer.error && !viewer.preparationBlocked
	);
	const helpEnabled = $derived(documentAvailable);
	$effect(() => {
		if (helpReady && documentAvailable) help.considerAutomatic();
	});
	$effect(() => {
		if (!active) help.close();
	});
	function openHelp() {
		if (helpEnabled) help.openManually();
	}
	const searchEnabled = $derived(
		Boolean(active && viewer.displayedSnapshot && viewer.pagesVisible)
	);
	const searchSession = new DocumentSearchSession();
	let activePanel = $state<UtilityPanelName | null>(null);
	let panel = $state<UtilityPanel>();
	const searchOpen = $derived(activePanel === 'search');
	let panelElement = $state<HTMLElement>();
	let searchInputElement = $state<HTMLInputElement | null>();
	$effect(() => searchSession.setPanel(searchOpen ? panelElement : undefined));
	let desktopRailElement = $state<HTMLElement>();
	let mobileRailElement = $state<HTMLElement>();
	$effect(() => {
		if (!active) closePanel(false);
	});
	function closePanel(restoreFocus = true) {
		panel?.close(restoreFocus);
	}
	function openSearch(trigger?: HTMLButtonElement) {
		panel?.show('search', trigger);
	}
	function toggleSearch(trigger: HTMLButtonElement) {
		if (!searchEnabled) return;
		if (searchOpen) {
			closePanel();
			return;
		}
		openSearch(trigger);
	}

	function handleKeydown(event: KeyboardEvent) {
		if (!searchEnabled || event.defaultPrevented || interactions.modalOpen()) return;
		const isFindShortcut =
			(event.metaKey || event.ctrlKey) &&
			!event.altKey &&
			!event.shiftKey &&
			event.key.toLowerCase() === 'f';

		if (isFindShortcut) {
			event.preventDefault();
			openSearch(panel?.visibleButton('search'));
		}
	}

	$effect(() => {
		const target = searchEnabled ? viewer.documentStageElement : undefined;
		if (!searchEnabled && searchOpen) closePanel(false);
		void viewer.displayedSnapshot?.id;
		const pages = viewer.displayedSnapshot?.pages ?? [];
		let cancelled = false;
		void tick().then(() => {
			if (cancelled) return;
			searchSession.setTarget(target ?? undefined);
			searchSession.setPages(pages);
			searchSession.refresh(false);
			if (target) recordColdStart('search-ready');
		});
		return () => {
			cancelled = true;
		};
	});

	$effect(() => {
		if (!onTools || !active) return;
		return onTools({
			owner,
			get searchOpen() {
				return activePanel === 'search';
			},
			searchEnabled,
			helpEnabled,
			onSearchToggle: toggleSearch,
			onOpenHelp: openHelp,
			closePanel,
			setRails: (desktop, mobile) => {
				desktopRailElement = desktop;
				mobileRailElement = mobile;
			}
		});
	});

	onMount(() => {
		const releaseShortcut = interactions.shortcut(handleKeydown);
		return () => {
			releaseShortcut();
			searchSession.destroy();
		};
	});
</script>

<UtilityPanel
	bind:this={panel}
	bind:activePanel
	bind:element={panelElement}
	{owner}
	desktop={desktopRailElement}
	mobile={mobileRailElement}
	onLeave={(name) => {
		if (name === 'search') searchSession.clear();
	}}
	focusTarget={() => ({
		element: searchInputElement,
		preventScroll: true
	})}
>
	{#snippet children()}
		<DocumentSearchPanel session={searchSession} bind:inputElement={searchInputElement} />
	{/snippet}
</UtilityPanel>

{#if !onTools}
	<UtilityRail
		{searchOpen}
		bind:desktopElement={desktopRailElement}
		bind:mobileElement={mobileRailElement}
		{searchEnabled}
		onSearchToggle={toggleSearch}
		{helpEnabled}
		helpLabel={helpContent[helpVariant].title}
		{onDownload}
		{downloadReason}
		{settingsHref}
		onOpenHelp={openHelp}
	/>
{/if}

{#if helpEnabled && help.open}
	<HelpModal variant={helpVariant} {isAdmin} {help} onClose={() => help.close()} />
{/if}
