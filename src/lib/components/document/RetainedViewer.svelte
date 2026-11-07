<script lang="ts">
	import { untrack } from 'svelte';
	import { setContractWorkspace } from '$lib/document/runtime/workspace-context';
	import type { DocumentResource } from '$lib/document/runtime/resources.svelte';
	import { setInteractionOwner } from '$lib/components/ui/interactions';
	import ContractViewer from './ContractViewer.svelte';
	let { entry, paused = false }: { entry: DocumentResource; paused?: boolean } = $props();
	setContractWorkspace(untrack(() => entry.workspace));
	setInteractionOwner(untrack(() => entry.owner));
	let element = $state<HTMLDivElement>();
	let parking = $state<HTMLDivElement>();
	$effect(() => {
		const node = element,
			destination = entry.target ?? parking;
		if (node && destination && node.parentElement !== destination) destination.append(node);
		return () => {
			if (node && parking && node.parentElement !== parking) parking.append(node);
		};
	});
	const bindings = $derived(entry.bindings);
	// Reparenting the same wrapper preserves every DocumentPage and annotation owner.
	const readyToShow = $derived(
		!paused && ((entry.active && (bindings?.active ?? true)) || entry.draftOwned)
	);
</script>

<div
	bind:this={parking}
	class="pointer-events-none invisible fixed top-0 left-[-100000px] w-full [contain:layout_paint]"
	inert
	aria-hidden="true"
>
	<div
		bind:this={element}
		data-document-resource={entry.id}
		class={!readyToShow
			? 'pointer-events-none invisible fixed top-0 left-[-100000px] w-full [contain:layout_paint]'
			: ''}
		inert={!entry.active}
		aria-hidden={!readyToShow}
	>
		<ContractViewer
			active={readyToShow}
			interactive={!paused && entry.active && (bindings?.interactive ?? true)}
			retained
			prepare={!paused && entry.allowed && (bindings?.prepare ?? true)}
			instructionPreload={entry.active ? bindings?.instructionPreload : undefined}
			priority={entry.priority}
			selectedConcessions={bindings?.selectedConcessions ?? entry.choices}
			previewChanges={bindings?.previewChanges}
			reviewTags={entry.active ? bindings?.reviewTags : undefined}
			reviewGutter={entry.active ? bindings?.reviewGutter : undefined}
			reviewNavigation={entry.active ? bindings?.reviewNavigation : undefined}
			onReviewDecision={bindings?.onReviewDecision}
			hasPanel={bindings?.hasPanel}
			followScroll={bindings?.followScroll}
			selectedAnnotationId={bindings?.selectedAnnotationId}
			selectionRequest={bindings?.selectionRequest}
			selectedRanges={bindings?.selectedRanges}
			panelTarget={bindings?.panelTarget}
			picking={bindings?.picking}
			sourceSelectionEnabled={bindings?.sourceSelectionEnabled}
			allowPlaybookNavigation={bindings?.allowPlaybookNavigation ?? false}
			playbookNavigationReady={bindings?.playbookNavigationReady}
			onRemoveConcession={bindings?.onRemoveConcession ?? (() => {})}
			onSelect={bindings?.onSelect ?? (() => false)}
			onDocumentBackground={bindings?.onDocumentBackground}
			onPresentation={entry.active && readyToShow ? bindings?.onPresentation : undefined}
		>
			{#snippet panelContent()}{#if entry.active && bindings}{@render bindings.panelContent()}{/if}{/snippet}
			{#snippet footerContent()}{#if entry.active && bindings?.footerContent}{@render bindings.footerContent()}{/if}{/snippet}
		</ContractViewer>
	</div>
</div>
