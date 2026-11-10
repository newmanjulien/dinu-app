<script lang="ts">
	const helpScope = useHelpPreferenceScope();
	import { recordColdStart } from '$lib/document/runtime/render-perf';
	import { DocumentSearchSession } from '$lib/document/search/search-session.svelte';
	import UtilityRail from '$lib/components/chrome/UtilityRail.svelte';
	import HeaderContent from '$lib/components/chrome/HeaderContent.svelte';
	import DocumentSearchPanel from '$lib/components/search/DocumentSearchPanel.svelte';
	import HelpModal from '$lib/components/ui/modal/HelpModal.svelte';
	import { helpContent, type HelpVariant } from '$lib/components/ui/modal/help-content';
	import { isHelpHidden, useHelpPreferenceScope } from '$lib/components/ui/modal/help-storage';
	import { onMount, tick } from 'svelte';
	import { getDocumentWorkspace } from '$lib/document/runtime/workspace-context';
	import {
		getInteractionController,
		getInteractionOwner,
		protectedInteraction
	} from '$lib/components/ui/interactions';
	const interactions = getInteractionController();
	const owner = getInteractionOwner();
	const searchId = Symbol('document-search');
	const protect = protectedInteraction();
	let {
		active = true,
		isAdmin = false,
		helpVariant,
		helpReady,
		onDownload,
		downloadReason = null,
		settingsHref
	}: {
		active?: boolean;
		isAdmin?: boolean;
		helpVariant: HelpVariant;
		helpReady: boolean;
		onDownload?: () => void;
		downloadReason?: string | null;
		settingsHref?: string;
	} = $props();
	const { source, renderer, viewer } = getDocumentWorkspace();
	let helpInitialized = $state(false);
	let helpOpen = $state(false);
	const documentAvailable = $derived(
		active && viewer.pagesVisible && !source.issue && !renderer.error && !viewer.preparationBlocked
	);
	const helpEnabled = $derived(helpInitialized && documentAvailable);
	$effect(() => {
		if (!helpReady || !documentAvailable) return;
		// Rep and buyer help open once per document opening; template help is manual.
		if (helpInitialized) return;
		helpInitialized = true;
		helpOpen =
			(helpVariant === 'rep' || helpVariant === 'buyer') && !isHelpHidden(helpVariant, helpScope());
	});
	$effect(() => {
		if (!active) helpOpen = false;
	});
	function openHelp() {
		if (!helpEnabled) return;
		helpOpen = true;
	}
	const searchEnabled = $derived(
		Boolean(active && viewer.displayedSnapshot && viewer.pagesVisible)
	);
	const searchSession = new DocumentSearchSession();
	let searchOpen = $state(false);
	let searchPanelElement = $state<HTMLElement>();
	let searchInputElement = $state<HTMLInputElement | null>();
	$effect(() => searchSession.setPanel(searchPanelElement));
	let searchButton: HTMLButtonElement | undefined;
	let desktopSearchButton = $state<HTMLButtonElement | null>();
	let mobileSearchButton = $state<HTMLButtonElement | null>();
	let utilityRailElement = $state<HTMLElement>();
	$effect(() => {
		if (!searchOpen) return;
		return interactions.register({
			id: searchId,
			owner,
			kind: 'utility',
			elements: () => [
				searchPanelElement ?? undefined,
				mobileSearchButton ?? undefined,
				utilityRailElement ?? undefined
			],
			close: (reason) => closeSearch(reason === 'escape')
		});
	});

	function visibleSearchButton() {
		return [searchButton, mobileSearchButton, desktopSearchButton].find(
			(button) => button?.isConnected && button.getClientRects().length
		);
	}

	function closeSearch(restoreFocus = true) {
		if (!searchOpen) return;
		searchOpen = false;
		searchSession.clear();
		searchPanelElement = undefined;
		searchInputElement = undefined;
		if (restoreFocus) void tick().then(() => visibleSearchButton()?.focus({ preventScroll: true }));
	}

	function toggleSearch(trigger: HTMLButtonElement) {
		if (!searchEnabled) return;
		if (searchOpen) {
			closeSearch();
			return;
		}
		searchButton = trigger;
		searchOpen = true;
	}

	function focusSearchInput() {
		void tick().then(() => searchInputElement?.focus({ preventScroll: true }));
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
			if (!searchOpen) {
				searchButton = visibleSearchButton() ?? undefined;
				searchOpen = true;
			}
			focusSearchInput();
			return;
		}
	}

	$effect(() => {
		const target = searchEnabled ? viewer.documentStageElement : undefined;
		if (!searchEnabled) closeSearch(false);
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

	onMount(() => {
		const releaseShortcut = interactions.shortcut(handleKeydown);
		return () => {
			releaseShortcut();
			searchSession.destroy();
		};
	});
</script>

{#if searchOpen}
	<HeaderContent>
		<div
			use:protect
			class="pointer-events-auto absolute top-0 left-[84px] w-[378px] max-[999px]:static max-[999px]:w-full"
		>
			<DocumentSearchPanel
				session={searchSession}
				bind:panelElement={searchPanelElement}
				bind:inputElement={searchInputElement}
			/>
		</div>
	</HeaderContent>
{/if}

<UtilityRail
	{searchOpen}
	bind:desktopElement={utilityRailElement}
	bind:desktopSearchElement={desktopSearchButton}
	bind:mobileSearchElement={mobileSearchButton}
	{searchEnabled}
	onSearchToggle={toggleSearch}
	{helpEnabled}
	helpLabel={`Help: ${helpContent[helpVariant].title}`}
	{onDownload}
	{downloadReason}
	{settingsHref}
	onOpenHelp={openHelp}
/>

{#if helpEnabled && helpOpen}
	<HelpModal variant={helpVariant} {isAdmin} onClose={() => (helpOpen = false)} />
{/if}
