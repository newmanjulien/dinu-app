<script lang="ts">
	import { useConvexClient } from 'convex-svelte';
	import { releasedRecord } from '$lib/contract/released-selections';
	import { sameSelection } from '$lib/playbook/model';
	import { DiscussionSession } from '$lib/discussions/session.svelte';
	import { onDestroy, untrack } from 'svelte';
	import type { FunctionReturnType } from 'convex/server';
	import type { api } from '../../convex/_generated/api';
	import { createDocumentWorkspace } from '$lib/document/runtime/workspace-factory';
	import { setDocumentWorkspace } from '$lib/document/runtime/workspace-context';
	import { documentAnnotations, type DocumentOverlayItem } from '$lib/playbook/document-overlay';
	import { setInteractionOwner } from '$lib/components/ui/interactions';
	import { setAnnotationLabel } from '$lib/document/annotation-label';
	import DocumentViewer from '$lib/components/document/DocumentViewer.svelte';
	import BuyerDocumentFrame from './BuyerDocumentFrame.svelte';
	import BuyerDocumentTools from './BuyerDocumentTools.svelte';
	import PlaybookCard from '$lib/components/playbook/PlaybookCard.svelte';
	import PlaybookSummary from '$lib/components/playbook/PlaybookSummary.svelte';
	import BoxDismissal from '$lib/components/playbook/BoxDismissal.svelte';
	import type { Priority } from '$lib/document/runtime/scheduler';
	import type { PresentationOutcome } from '$lib/auth/workspace-presentation.svelte';
	let {
		content,
		token,
		active = true,
		prepare = true,
		priority = () => 'foreground',
		tools = false,
		showDesktopClose = false,
		failure = null,
		onDisplayed,
		onClauseOpen,
		onPresentation,
		onFailure,
		onRetry
	}: {
		token?: string;
		content: FunctionReturnType<typeof api.buyerLinks.content>;
		active?: boolean;
		prepare?: boolean;
		priority?: Priority;
		tools?: boolean;
		showDesktopClose?: boolean;
		failure?: string | null;
		onDisplayed?: (content: FunctionReturnType<typeof api.buyerLinks.content>) => () => void;
		onClauseOpen?: (itemId: string) => void;
		onPresentation?: (outcome: PresentationOutcome) => void;
		onFailure?: (stage: 'source' | 'preparation' | 'page-mount') => void;
		onRetry?: () => void;
	} = $props();
	const initial = untrack(() => content);
	const selection = $derived(releasedRecord(content.selections));
	const overlays = $derived(
		content.items.map((item) => ({
			itemId: item.itemId,
			trigger: item.trigger,
			concessions: item.concessions,
			annotations: documentAnnotations({ _id: item.itemId, ...item })
		}))
	);
	const summaries = $derived(
		content.explanations
			.filter((item) => item.explanation.trim())
			.map((item) => ({
				itemId: item.itemId,
				annotations: documentAnnotations({
					_id: item.itemId,
					trigger: item.trigger,
					concessions: []
				})
			}))
	);
	const workspace = setDocumentWorkspace(
		createDocumentWorkspace(
			{
				kind: 'overlays',
				contract: true,
				blocks: { data: initial.blocks },
				overlays: untrack(() => overlays)
			},
			'effective'
		)
	);
	const owner = setInteractionOwner(Symbol('buyer-document'));
	setAnnotationLabel('clause summary');
	$effect(() => {
		const current = overlays,
			selection = releasedRecord(content.selections);
		untrack(() => {
			workspace.accept({
				kind: 'overlays',
				contract: true,
				blocks: { data: initial.blocks },
				overlays: current
			});
			workspace.source.setSelection(selection);
		});
	});
	$effect(() => {
		const displayed = workspace.viewer.displayedSnapshot;
		if (
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
			sameSelection(displayed.concessions, selection)
		)
			return onDisplayed?.(content);
	});

	const discussions = untrack(() =>
		token
			? new DiscussionSession(useConvexClient(), { token }, () => content.buyerRevision)
			: undefined
	);
	$effect(() => discussions?.setActive(active && prepare));
	onDestroy(() => discussions?.destroy());
	let selectedId = $state<string | null>(null);
	let selectedAnnotationId = $state<string | null>(null);
	const selected = $derived(content.explanations.find((i) => i.itemId === selectedId));
	function close(restore = true) {
		const focus = restore ? workspace.viewer.captureAnnotationFocus?.() : undefined;
		selectedId = null;
		selectedAnnotationId = null;
		if (focus) focus();
	}
	$effect(() => {
		if (!active) untrack(() => close(false));
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

<BoxDismissal
	{owner}
	active={active && Boolean(selected)}
	onDismiss={(restore) => close(restore)}
/>
{#snippet panelContent()}
	{#if selected?.explanation.trim()}
		<PlaybookCard label="Clause summary">
			<PlaybookSummary
				text={selected.explanation}
				closeLabel="Close clause summary"
				{showDesktopClose}
				onClose={() => close()}
			/>
		</PlaybookCard>
	{/if}
{/snippet}
<BuyerDocumentFrame withTools={tools}>
	{#if tools}<BuyerDocumentTools active={active && prepare} />{/if}
	{#if workspace.source.issue}
		<p role="alert" class="p-8 text-center text-sm">
			This contract version is unavailable. Ask your rep for a new link.
		</p>
	{:else}
		<DocumentViewer
			instructionAudience="buyer"
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
			selectedConcessions={selection}
			onRemoveConcession={() => {}}
			hasPanel={Boolean(selected)}
			{selectedAnnotationId}
			panelTarget={selected?.trigger.target}
			onSelect={(itemId, annotationId) => {
				if (!active || !content.explanations.find((i) => i.itemId === itemId)?.explanation.trim())
					return false;
				const changed = selectedId !== itemId;
				selectedId = itemId;
				selectedAnnotationId = annotationId;
				if (changed) onClauseOpen?.(itemId);
				return true;
			}}
			onDocumentBackground={() => close(false)}
		/>
	{/if}
</BuyerDocumentFrame>
