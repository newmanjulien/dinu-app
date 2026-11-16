<script lang="ts">
	import { recordColdStart } from '$lib/document/runtime/render-perf';
	import { DocumentSearchSession } from '$lib/document/search/search-session.svelte';
	import UtilityPanel, { type UtilityPanelName } from './UtilityPanel.svelte';
	import DocumentSearchPanel from '$lib/components/search/DocumentSearchPanel.svelte';
	import { onMount, tick } from 'svelte';
	import type { DocumentWorkspace } from '$lib/document/runtime/workspace-context';
	import { matchesMountedSnapshot } from '$lib/document/runtime/viewer.svelte';
	import { getInteractionController } from '$lib/components/ui/interactions';
	import type { SearchToolControls } from './document-tools';
	const interactions = getInteractionController();
	let {
		active = true,
		workspace,
		interactionOwner: owner,
		onControls
	}: {
		active?: boolean;
		workspace: DocumentWorkspace;
		interactionOwner?: symbol;
		onControls: (controls: SearchToolControls) => () => void;
	} = $props();
	const viewer = $derived(workspace.viewer);
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
		const snapshot = searchEnabled ? viewer.displayedSnapshot : null;
		const revision = viewer.mountedDomRevision;
		const target = viewer.documentStageElement;
		// Drop live ranges as soon as this stage no longer matches the displayed document.
		searchSession.setMountedDocument(undefined, null);
		if (!searchEnabled && searchOpen) closePanel(false);
		if (!snapshot || !revision || !target || !matchesMountedSnapshot(revision, snapshot)) return;
		let cancelled = false;
		void tick().then(() => {
			if (cancelled) return;
			if (
				!active ||
				!viewer.pagesVisible ||
				viewer.displayedSnapshot !== snapshot ||
				viewer.mountedDomRevision !== revision ||
				viewer.documentStageElement !== target ||
				!matchesMountedSnapshot(revision, snapshot)
			)
				return;
			searchSession.setMountedDocument(target, revision);
			recordColdStart('search-ready');
		});
		return () => {
			cancelled = true;
		};
	});

	$effect(() => {
		if (!active) return;
		return onControls({
			owner,
			get searchOpen() {
				return activePanel === 'search';
			},
			searchEnabled,
			onSearchToggle: toggleSearch,
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
