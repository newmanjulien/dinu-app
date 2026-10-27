<script lang="ts">
	import { recordColdStart } from '$lib/document/runtime/render-perf';
	import { DocumentSearchSession } from '$lib/document/search/search-session.svelte';
	import UtilityRail from '$lib/components/chrome/UtilityRail.svelte';
	import HeaderContent from '$lib/components/chrome/HeaderContent.svelte';
	import InfoIcon from 'phosphor-svelte/lib/InfoIcon';
	import DocumentSearchPanel from '$lib/components/search/DocumentSearchPanel.svelte';
	import AppStatus from '$lib/components/chrome/AppStatus.svelte';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
	import SquareIconButton from '$lib/components/ui/SquareIconButton.svelte';
	import HelpModal from '$lib/components/ui/modal/HelpModal.svelte';
	import type { HelpVariant } from '$lib/components/ui/modal/help-content';
	import { isHelpHidden } from '$lib/components/ui/modal/help-storage';
	import { onMount, tick } from 'svelte';
	import { getContractWorkspace } from '$lib/document/runtime/context';
	import { useViewer } from '$lib/auth/viewer-session.svelte';
	import type { OperationStatus } from '$lib/components/chrome/operation-status';
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
		feedback = null,
		helpVariant,
		helpReady
	}: {
		feedback?: OperationStatus | null;
		helpVariant: HelpVariant;
		helpReady: boolean;
	} = $props();
	const { source, renderer, viewer } = getContractWorkspace();
	const accountViewer = useViewer();
	let helpInitialized = $state(false);
	let helpOpen = $state(false);
	const documentAvailable = $derived(
		viewer.visible && !source.issue && !renderer.error && !viewer.preparationBlocked
	);
	const helpEnabled = $derived(helpInitialized && documentAvailable);
	$effect(() => {
		// Check the preference once per workspace opening, after its document is usable.
		if (!helpReady || !documentAvailable || helpInitialized) return;
		helpInitialized = true;
		helpOpen = !isHelpHidden(helpVariant);
	});
	function openHelp() {
		if (helpEnabled) helpOpen = true;
	}
	const searchEnabled = $derived(Boolean(viewer.displayedSnapshot && viewer.visible));
	const searchSession = new DocumentSearchSession();
	let searchOpen = $state(false);
	let searchPanelElement = $state<HTMLElement>();
	let searchInputElement = $state<HTMLInputElement>();
	$effect(() => searchSession.setPanel(searchPanelElement));
	let searchButton: HTMLButtonElement | undefined;
	let desktopSearchButton = $state<HTMLButtonElement>();
	let mobileSearchButton = $state<HTMLButtonElement>();
	let utilityRailElement = $state<HTMLElement>();
	$effect(() => {
		if (!searchOpen) return;
		return interactions.register({
			id: searchId,
			owner,
			kind: 'utility',
			elements: () => [searchPanelElement, mobileSearchButton, utilityRailElement],
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
				searchButton = visibleSearchButton();
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
			searchSession.setTarget(target);
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

<HeaderContent>
	<div
		class="pointer-events-none absolute top-[calc(100%+20px)] right-0 left-0 flex justify-center max-[999px]:top-[calc(100%+8px)] max-[999px]:right-3 max-[999px]:left-auto max-[999px]:w-[min(454px,calc(100vw-24px))] max-[999px]:flex-col max-[999px]:items-end max-[999px]:gap-2"
	>
		{#if searchOpen}
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
		{/if}
		<div
			class={`flex w-fit max-w-[min(640px,calc(100vw-32px))] flex-col gap-2 max-[999px]:w-full ${searchOpen ? 'ml-auto max-w-[calc(100vw-486px)] max-[999px]:max-w-none' : ''}`}
		>
			<AppStatus
				{feedback}
				renderPending={Boolean(viewer.displayedSnapshot && renderer.pending)}
				renderError={viewer.displayedSnapshot ? renderer.error : null}
				sourceStale={Boolean(viewer.displayedSnapshot && source.issue)}
				onRetryRender={viewer.retry}
			/>
		</div>
	</div>
</HeaderContent>

<div
	use:protect
	class="fixed top-[calc(var(--app-header-height)+8px)] left-2 z-20 flex gap-1 rounded-lg border-hairline border-edge bg-surface shadow-floating min-[1000px]:hidden"
>
	<SquareIconButton
		bind:element={mobileSearchButton}
		type="button"
		rounded="lg"
		disabled={!searchEnabled}
		aria-label="Search contract"
		aria-pressed={searchOpen}
		aria-controls="document-search"
		onclick={() => mobileSearchButton && toggleSearch(mobileSearchButton)}
	>
		<MagnifyingGlassIcon aria-hidden="true" size={19} weight="regular" />
	</SquareIconButton>
	<SquareIconButton
		type="button"
		rounded="lg"
		disabled={!helpEnabled}
		aria-label="Help: How Dinu works"
		onclick={openHelp}><InfoIcon aria-hidden="true" size={19} weight="regular" /></SquareIconButton
	>
</div>

<div
	use:protect
	bind:this={utilityRailElement}
	class="pointer-events-none fixed top-[calc(var(--app-header-height)+14px)] left-[4px] z-15 max-[999px]:hidden"
>
	<UtilityRail
		{searchOpen}
		bind:searchElement={desktopSearchButton}
		{searchEnabled}
		onSearchToggle={toggleSearch}
		{helpEnabled}
		onOpenHelp={openHelp}
	/>
</div>

{#if helpEnabled && helpOpen}
	<HelpModal
		variant={helpVariant}
		isAdmin={helpVariant === 'rep' && accountViewer().profile.role === 'admin'}
		onClose={() => (helpOpen = false)}
	/>
{/if}
