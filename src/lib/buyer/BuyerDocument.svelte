<script lang="ts">
	import type { DiscussionSession } from '$lib/discussions/session.svelte';
	import { onDestroy, untrack } from 'svelte';
	import { createDocumentWorkspace } from '$lib/document/runtime/workspace-factory';
	import { setDocumentWorkspace } from '$lib/document/runtime/workspace-context';
	import {
		documentAnnotations,
		filterOverlappedExplanations,
		toAppliedOverlayItems
	} from '$lib/playbook/document-overlay';
	import { sameSelection } from '$lib/playbook/model';
	import { setInteractionOwner } from '$lib/components/ui/interactions';
	import { setAnnotationLabel } from '$lib/document/annotation-label';
	import DocumentViewer from '$lib/components/document/DocumentViewer.svelte';
	import BuyerDocumentFrame from './BuyerDocumentFrame.svelte';
	import DocumentTools from '$lib/components/document/DocumentTools.svelte';
	import type { DocumentToolControls } from '$lib/components/document/document-tools';
	import DocumentPanelCard from '$lib/components/document/DocumentPanelCard.svelte';
	import DocumentPanelBody from '$lib/components/document/DocumentPanelBody.svelte';
	import ClauseText from '$lib/components/playbook/ClauseText.svelte';
	import BoxDismissal from '$lib/components/playbook/BoxDismissal.svelte';
	import type { Priority } from '$lib/document/runtime/scheduler';
	import type { PresentationOutcome } from '$lib/auth/workspace-presentation.svelte';
	import { getBuyerContract, type BuyerDocumentContent } from './contract.svelte';
	import BuyerDiscussions from './BuyerDiscussions.svelte';
	import Button from '$lib/ui/Button.svelte';

	type Content = BuyerDocumentContent;
	let {
		content,
		token,
		active = true,
		prepare = true,
		priority = () => 'foreground',
		failure = null,
		onDisplayed,
		onClauseOpen,
		onPresentation,
		onFailure,
		onRetry
	}: {
		token: string;
		content: Content;
		active?: boolean;
		prepare?: boolean;
		priority?: Priority;
		failure?: string | null;
		onDisplayed?: (content: Content) => () => void;
		onClauseOpen?: (itemId: string) => void;
		onPresentation?: (outcome: PresentationOutcome) => void;
		onFailure?: (stage: 'source' | 'preparation' | 'page-mount') => void;
		onRetry?: () => void;
	} = $props();

	const overlayItems = $derived(toAppliedOverlayItems(content.appliedOverlays));
	const workspace = setDocumentWorkspace(
		createDocumentWorkspace(
			{
				kind: 'overlays',
				contract: true,
				blocks: { data: untrack(() => content.blocks) },
				overlays: untrack(() => overlayItems)
			},
			'effective'
		)
	);
	const explanations = $derived.by(() => {
		const compiled = workspace.source.compiled;
		if (!compiled) return [];
		return filterOverlappedExplanations(
			compiled.index,
			content.rawExplanations,
			overlayItems,
			content.concessions
		);
	});
	const summaries = $derived(
		explanations
			.filter((item) => item.explanation.trim())
			.map((item) => ({
				itemId: item.itemId,
				annotations: documentAnnotations({
					_id: item.itemId,
					audience: 'buyer',
					trigger: item.trigger,
					concessions: []
				})
			}))
	);
	const owner = setInteractionOwner(Symbol('buyer-document'));
	const publicContract = getBuyerContract();
	setAnnotationLabel('explanation');

	let acceptedBlocks: Content['blocks'] | undefined = untrack(() => content.blocks);
	let acceptedOverlaysKey = untrack(() => JSON.stringify(content.appliedOverlays));
	let acceptedConcessionsKey = '';
	$effect(() => {
		const blocks = content.blocks,
			overlays = overlayItems,
			concessions = content.concessions;
		const overlaysKey = JSON.stringify(content.appliedOverlays);
		const concessionsKey = JSON.stringify(concessions);
		untrack(() => {
			if (blocks !== acceptedBlocks || overlaysKey !== acceptedOverlaysKey) {
				acceptedBlocks = blocks;
				acceptedOverlaysKey = overlaysKey;
				workspace.accept({
					kind: 'overlays',
					contract: true,
					blocks: { data: blocks },
					overlays
				});
				acceptedConcessionsKey = '';
			}
			if (concessionsKey !== acceptedConcessionsKey) {
				acceptedConcessionsKey = concessionsKey;
				workspace.source.setSelection(concessions);
			}
		});
	});

	const contentDisplayed = $derived.by(() => {
		const displayed = workspace.viewer.displayedSnapshot;
		return Boolean(
			active &&
			prepare &&
			!failure &&
			!workspace.source.issue &&
			workspace.viewer.pagesVisible &&
			workspace.viewer.layoutPrepared &&
			workspace.viewer.interactionEnabled &&
			displayed &&
			displayed === workspace.renderer.snapshot &&
			displayed.source === workspace.source.renderSource &&
			sameSelection(displayed.concessions, content.concessions)
		);
	});
	$effect(() => {
		if (contentDisplayed) return onDisplayed?.(content);
	});

	const generation = untrack(() => publicContract.generation);
	const bindTools = (tools: DocumentToolControls) => publicContract.bindTools(generation, tools);
	let discussions = $state.raw<DiscussionSession>();
	let selectedId = $state<string | null>(null);
	let selectedAnnotationId = $state<string | null>(null);
	const selected = $derived(explanations.find((i) => i.itemId === selectedId));
	let animateExplanationContent = $state(false);
	function close(restore = true) {
		const focus = restore ? workspace.viewer.captureAnnotationFocus?.() : undefined;
		animateExplanationContent = false;
		selectedId = null;
		selectedAnnotationId = null;
		if (focus) focus();
	}
	$effect(() => {
		if (!active) untrack(() => close(false));
	});
	$effect(() => {
		if (selectedId && !selected) {
			animateExplanationContent = false;
			selectedId = null;
			selectedAnnotationId = null;
		}
	});
	$effect(() => {
		if (workspace.source.issue) onFailure?.('source');
		else if (workspace.renderer.error) onFailure?.('preparation');
	});
	const renderFailure = $derived(failure ? { message: failure } : undefined);
	onDestroy(() => {
		workspace.renderer.destroy();
		workspace.source.destroy();
	});
</script>

<svelte:boundary
	onerror={() => {
		console.error('Buyer discussions failed', { stage: 'session' });
		untrack(() => (discussions = undefined));
	}}
>
	<BuyerDiscussions
		{content}
		{token}
		{active}
		{prepare}
		onSession={(session) => (discussions = session)}
	/>
	{#snippet failed(_error, reset)}
		<div role="alert" class="flex items-center justify-center gap-3 px-4 py-2 text-xs text-danger">
			<span>Discussions are unavailable.</span>
			<Button variant="secondary" onclick={reset}>Retry discussions</Button>
		</div>
	{/snippet}
</svelte:boundary>
<BoxDismissal
	{owner}
	active={active && Boolean(selected)}
	onDismiss={(restore) => close(restore)}
/>
{#snippet panelContent()}
	{#if selected?.explanation.trim()}
		<DocumentPanelCard label="Clause explanation">
			<DocumentPanelBody>
				{#key selected.itemId}
					<ClauseText text={selected.explanation} animateContent={animateExplanationContent} />
				{/key}
			</DocumentPanelBody>
		</DocumentPanelCard>
	{/if}
{/snippet}
<BuyerDocumentFrame>
	<DocumentTools
		active={active && prepare}
		help={publicContract.help}
		helpHosted
		helpReady={workspace.viewer.interactionEnabled}
		onTools={bindTools}
	/>
	{#if workspace.source.issue}
		<p role="alert" class="p-8 text-center text-sm">
			This contract is unavailable. Ask your rep for help.
		</p>
	{:else}
		<DocumentViewer
			{discussions}
			{active}
			{prepare}
			{priority}
			retained
			failure={renderFailure}
			onPresentation={(outcome) =>
				onPresentation?.(
					outcome === 'success' &&
						(!workspace.viewer.interactionEnabled || !workspace.renderer.snapshot?.pages.length)
						? 'pending'
						: outcome
				)}
			onFailure={() => onFailure?.('page-mount')}
			{onRetry}
			{panelContent}
			annotationItems={summaries}
			selectedConcessions={content.concessions}
			hasPanel={Boolean(selected)}
			{selectedAnnotationId}
			panelTarget={selected?.trigger.target}
			onSelect={(itemId, annotationId) => {
				if (!active || !explanations.find((i) => i.itemId === itemId)?.explanation.trim())
					return false;
				const changed = selectedId !== itemId;
				animateExplanationContent = Boolean(selected) && changed;
				selectedId = itemId;
				selectedAnnotationId = annotationId;
				if (changed) onClauseOpen?.(itemId);
				return true;
			}}
			onDocumentBackground={() => close(false)}
		/>
	{/if}
</BuyerDocumentFrame>
