<script lang="ts">
	import { untrack } from 'svelte';
	import { setDocumentWorkspace } from '$lib/document/runtime/workspace-context';
	import type { DocumentResource } from '$lib/document/runtime/resources.svelte';
	import { setInteractionOwner } from '$lib/components/ui/interactions';
	import DocumentViewer from './DocumentViewer.svelte';
	import RetainedDocumentMount from './RetainedDocumentMount.svelte';
	let { entry, paused = false }: { entry: DocumentResource; paused?: boolean } = $props();
	setDocumentWorkspace(untrack(() => entry.workspace));
	setInteractionOwner(untrack(() => entry.owner));
	const bindings = $derived(entry.bindings);
	// Reparenting the same wrapper preserves every DocumentPage and annotation owner.
	const readyToShow = $derived(
		!paused && ((entry.active && (bindings?.active ?? true)) || entry.draftOwned)
	);
</script>

<RetainedDocumentMount
	target={entry.target}
	visible={readyToShow}
	interactive={entry.active}
	resource={entry.id}
>
	<DocumentViewer
		instructionAudience={bindings?.instructionAudience}
		discussions={bindings?.discussions}
		failure={bindings?.failure}
		onRetry={bindings?.onRetry}
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
	</DocumentViewer>
</RetainedDocumentMount>
