<script lang="ts">
	import { untrack } from 'svelte';
	import { setDocumentWorkspace } from '$lib/document/runtime/workspace-context';
	import { setAnnotationLabel } from '$lib/document/annotation-label';
	import type { DocumentResource } from '$lib/document/runtime/resources.svelte';
	import { setInteractionOwner } from '$lib/components/ui/interactions';
	import DocumentViewer from './DocumentViewer.svelte';
	import RetainedDocumentMount from './RetainedDocumentMount.svelte';
	let { entry, paused = false }: { entry: DocumentResource; paused?: boolean } = $props();
	setDocumentWorkspace(untrack(() => entry.workspace));
	setInteractionOwner(untrack(() => entry.owner));
	// Retained viewers live under DocumentHost, outside their route's context.
	setAnnotationLabel(
		untrack(() => (entry.id === 'template:buyer' ? 'explanation' : 'instructions'))
	);
	const bindings = $derived(entry.bindings);
	let hasPanel = $state(false);
	// Binding replacement must not briefly collapse an already open panel's space.
	$effect.pre(() => {
		if (bindings) hasPanel = bindings.hasPanel ?? false;
	});
	// Reparenting the same wrapper preserves every DocumentPage and annotation owner.
	const readyToShow = $derived(
		!paused && Boolean(entry.target) && entry.active && (bindings?.active ?? true)
	);
</script>

<RetainedDocumentMount
	target={entry.target}
	visible={readyToShow}
	interactive={entry.active}
	resource={entry.id}
>
	<DocumentViewer
		reserveReviewGutter={entry.reserveReviewGutter}
		failure={bindings?.failure}
		onRetry={bindings?.onRetry}
		active={readyToShow}
		interactive={!paused && entry.active && (bindings?.interactive ?? true)}
		annotationsVisible={bindings?.annotationsVisible ?? true}
		retained
		prepare={!paused &&
			entry.allowed &&
			entry.workspace.source.renderReady &&
			(bindings?.prepare ?? true)}
		itemPreload={entry.active ? bindings?.itemPreload : undefined}
		priority={entry.priority}
		selectedConcessions={bindings?.selectedConcessions ?? entry.choices}
		previewChanges={bindings?.previewChanges}
		reviewTags={entry.active && bindings?.annotationsVisible !== false
			? bindings?.reviewTags
			: undefined}
		reviewNavigation={entry.active ? bindings?.reviewNavigation : undefined}
		onReviewDecision={bindings?.onReviewDecision}
		{hasPanel}
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
