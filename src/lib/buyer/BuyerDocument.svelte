<script lang="ts">
	import { page } from '$app/state';
	import { contractDocumentFromRenderTransport } from '$lib/document/contract-document';
	import type { DiscussionSession } from '$lib/discussions/session.svelte';
	import { onDestroy, untrack } from 'svelte';
	import type { FunctionReturnType } from 'convex/server';
	import type { api } from '../../convex/_generated/api';
	import { createDocumentWorkspace } from '$lib/document/runtime/workspace-factory';
	import { setDocumentWorkspace } from '$lib/document/runtime/workspace-context';
	import { documentAnnotations } from '$lib/playbook/document-overlay';
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
	import { getBuyerSeller } from './seller.svelte';
	import { getBuyerContract } from './contract.svelte';
	import BuyerChangeActions from './BuyerChangeActions.svelte';
	import BuyerDiscussions from './BuyerDiscussions.svelte';
	import { BuyerChangeReview } from './reviews.svelte';
	import Button from '$lib/ui/Button.svelte';
	import ReviewCompletedModal from '$lib/components/ui/modal/ReviewCompletedModal.svelte';
	type Content = FunctionReturnType<typeof api.buyerLinks.currentDocument>;
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
	const document = $derived(contractDocumentFromRenderTransport(content.document));
	const materialized = $derived({ document, baseline: [] });
	const selection = {};
	const overlays: import('$lib/playbook/document-overlay').DocumentOverlayItem[] = [];
	const explanations = $derived(content.explanations);
	const summaries = $derived([
		...explanations
			.filter((item) => item.explanation.trim())
			.map((item) => ({
				itemId: item.itemId,
				annotations: documentAnnotations({
					_id: item.itemId,
					audience: 'buyer',
					trigger: item.trigger,
					concessions: []
				})
			})),
		...content.annotationGroups.flatMap((group, groupIndex) =>
			group.map((footprint, index) => {
				const id = `approved-footprint:${groupIndex}:${index}`;
				return {
					itemId: id,
					annotations: [
						{
							id,
							itemId: id,
							kind: 'trigger' as const,
							triggerId: id,
							highlightKind: 'rep-attachment' as const,
							passive: true,
							target: footprint.target
						}
					]
				};
			})
		)
	]);
	const workspace = setDocumentWorkspace(
		createDocumentWorkspace(
			{
				kind: 'overlays',
				contract: true,
				materialized: { data: untrack(() => materialized) },
				overlays: untrack(() => overlays)
			},
			'effective'
		)
	);
	const owner = setInteractionOwner(Symbol('buyer-document'));
	const publicContract = getBuyerContract();
	setAnnotationLabel('explanation');
	$effect(() => {
		const current = overlays,
			snapshot = materialized;
		untrack(() => {
			workspace.accept({
				kind: 'overlays',
				contract: true,
				materialized: { data: snapshot },
				overlays: current
			});
			workspace.source.setSelection(selection);
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
			displayed.source.materialized?.document === document
		);
	});
	$effect(() => {
		if (contentDisplayed) return onDisplayed?.(content);
	});

	const seller = getBuyerSeller();
	const review = untrack(() => (seller ? new BuyerChangeReview(seller) : undefined));
	const reviewing = $derived(Boolean(seller?.visible));
	const reviewTags = $derived(
		reviewing &&
			contentDisplayed &&
			publicContract.displayed?.displayIdentity === content.displayIdentity
			? review?.tagsFor(content)
			: undefined
	);
	const reviewIdentity = $derived(
		seller?.visible
			? JSON.stringify([seller.identity, seller.accountIdentity, seller.viewer?.role])
			: undefined
	);
	$effect(() => {
		const identity = reviewIdentity,
			client = seller?.client;
		if (active && prepare && identity && client)
			return untrack(() =>
				review?.connect(
					() => content,
					() =>
						active &&
						prepare &&
						contentDisplayed &&
						publicContract.displayed?.displayIdentity === content.displayIdentity
				)
			);
	});
	let reviewedIdentity: string | undefined;
	$effect(() => {
		if (
			reviewIdentity &&
			review?.state &&
			seller?.viewer?.role === 'admin' &&
			page.url.searchParams.get('review') === '1' &&
			reviewedIdentity !== reviewIdentity
		) {
			reviewedIdentity = reviewIdentity;
			untrack(() => (review.navigation = {}));
		}
	});
	const generation = untrack(() => publicContract.generation);
	const bindTools = (tools: DocumentToolControls) => publicContract.bindTools(generation, tools);
	let discussions = $state.raw<DiscussionSession>();
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
				<ClauseText text={selected.explanation} />
			</DocumentPanelBody>
		</DocumentPanelCard>
	{/if}
{/snippet}
{#snippet documentActions(
	root: HTMLElement,
	layout: HTMLElement,
	highlights: import('$lib/document/highlights/controller').DocumentHighlightController | undefined,
	renderRevision: unknown,
	domRevision: unknown,
	ready: boolean
)}
	{#if seller?.visible && review && discussions}
		<svelte:boundary
			onerror={() => console.error('Buyer discussions failed', { stage: 'changes' })}
		>
			<BuyerChangeActions
				{review}
				session={discussions}
				{root}
				{layout}
				{highlights}
				{renderRevision}
				{domRevision}
				ready={ready && publicContract?.displayed?.contentIdentity === content.contentIdentity}
			/>
			{#snippet failed(_error, reset)}
				<div role="alert" class="p-3 text-xs text-danger">
					Change discussions are unavailable.
					<button class="underline" onclick={reset}>Retry</button>
				</div>
			{/snippet}
		</svelte:boundary>
	{/if}
{/snippet}
{#snippet footerContent()}
	{#if reviewing && review?.pages}
		{#if review.pages.error}<p role="alert" class="px-4 py-3 text-center text-sm text-danger">
				{review.pages.error}
				<button class="underline" onclick={() => review.pages?.reset()}>Try again</button>
			</p>{/if}
		{#if review.pages.detailError}<p role="alert" class="px-4 py-3 text-center text-sm text-danger">
				{review.pages.detailError}
				<button class="underline" onclick={() => review.pages?.retryDetails()}>Try again</button>
			</p>{/if}
		{#if !review.pages.done && !review.pages.error}<div class="flex justify-center py-4">
				<Button
					variant="secondary"
					disabled={review.pages.loading}
					onclick={() => review.pages?.loadMore()}
					>{review.pages.loading ? 'Loading reviews…' : 'Load more reviews'}</Button
				>
			</div>{/if}
	{/if}

	{#if reviewing && review && Boolean(review.state?.summary.pendingCount)}
		<div class="flex flex-col items-center gap-2 py-6">
			<Button
				disabled={review.busy || !review.state || Boolean(review.submitted)}
				onclick={() => void review.submit()}
				>{review.busy
					? 'Submitting…'
					: review.submitted
						? 'Submitted for approval'
						: 'Submit for approval'}</Button
			>
			{#if review.state?.request?.status === 'uncertain'}<p
					class="max-w-lg text-center text-sm text-ink-muted"
				>
					Delivery could not be confirmed. Retrying may send a duplicate email.
				</p>{/if}
		</div>
	{/if}
	{#if reviewing && review && seller?.viewer?.role === 'admin' && seller.viewer.completion?.completion.kind === 'awaitingConfirmation'}
		<div class="flex justify-center py-4">
			<Button
				variant="secondary"
				disabled={review.busy}
				onclick={() => (review.dismissed = undefined)}>Review complete</Button
			>
		</div>
	{/if}
	{#if seller?.visible && (review?.footerError || review?.state?.request?.error)}<p
			role="alert"
			class="px-4 py-3 text-center text-sm text-danger"
		>
			{review?.footerError || review?.state?.request?.error}
		</p>{/if}
{/snippet}
<BuyerDocumentFrame>
	<DocumentTools
		active={active && prepare}
		helpVariant="buyer"
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
			reserveReviewGutter
			{discussions}
			{documentActions}
			{footerContent}
			reviewTags={reviewTags ?? []}
			reviewNavigation={reviewTags ? review?.navigation : undefined}
			onReviewDecision={(tag, status) => void review?.decide(tag, status)}
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

{#if active && prepare && workspace.viewer.interactionEnabled && reviewing && seller?.viewer?.role === 'admin' && review?.completion}
	<ReviewCompletedModal
		buyerChanges
		busy={review.busy}
		error={review.footerError}
		onClose={() => (review.dismissed = review.state?.summary.identity)}
		onSend={() => void review.complete()}
	/>
{/if}
