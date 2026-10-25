<script lang="ts">
	import { untrack } from 'svelte';
	import { setContractWorkspace } from '$lib/document/runtime/context';
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

<div bind:this={parking} class="document-parking" inert aria-hidden="true">
	<div
		bind:this={element}
		data-document-resource={entry.id}
		class:dormant={!readyToShow}
		inert={!entry.active}
		aria-hidden={!readyToShow}
	>
		<ContractViewer
			active={readyToShow}
			interactive={!paused && entry.active && (bindings?.interactive ?? true)}
			retained
			prepare={!paused && entry.allowed && (bindings?.prepare ?? true)}
			priority={entry.priority}
			selectedConcessions={bindings?.selectedConcessions ?? entry.choices}
			previewChanges={bindings?.previewChanges}
			reviewTags={entry.active ? bindings?.reviewTags : undefined}
			reviewNavigation={entry.active ? bindings?.reviewNavigation : undefined}
			onReviewDecision={bindings?.onReviewDecision}
			hasPanel={bindings?.hasPanel}
			followScroll={bindings?.followScroll}
			selectedAnnotationId={bindings?.selectedAnnotationId}
			selectedRanges={bindings?.selectedRanges}
			panelSource={bindings?.panelSource}
			picking={bindings?.picking}
			allowPlaybookNavigation={bindings?.allowPlaybookNavigation ?? false}
			playbookNavigationReady={bindings?.playbookNavigationReady}
			onRemoveConcession={bindings?.onRemoveConcession ?? (() => {})}
			onSelect={bindings?.onSelect ?? (() => false)}
		>
			{#snippet panelContent()}{#if entry.active && bindings}{@render bindings.panelContent()}{/if}{/snippet}
			{#snippet footerContent()}{#if entry.active && bindings?.footerContent}{@render bindings.footerContent()}{/if}{/snippet}
		</ContractViewer>
	</div>
</div>

<style>
	.document-parking,
	.dormant {
		position: fixed;
		left: -100000px;
		top: 0;
		width: 100%;
		visibility: hidden;
		pointer-events: none;
		contain: layout paint;
	}
</style>
