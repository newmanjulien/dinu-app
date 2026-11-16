<script lang="ts">
	import { AuthoringController } from '$lib/playbook/authoring-controller.svelte';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { untrack, onMount, onDestroy, tick } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { getWorkspaceRuntime } from '$lib/auth/workspace-context.svelte';
	import { createDocumentWorkspace } from '$lib/document/runtime/workspace-factory';
	import { setDocumentWorkspace } from '$lib/document/runtime/workspace-context';
	import {
		recordTemplateQueryOwner,
		recordTemplateSourceUpdate,
		recordDocumentInput
	} from '$lib/document/runtime/render-perf';
	import { EMPTY_PREVIEW_CHANGES } from '$lib/document/runtime/types';
	import { sameSourceTarget } from '$lib/document/source-model';
	import { structuralBoundary } from '$lib/document/ranges';
	import { isRepItem, type SourceTarget, type TemplateAudience } from '$lib/playbook/model';
	import { templateCopy } from '$lib/playbook/template-copy';
	import { setAnnotationLabel } from '$lib/document/annotation-label';
	import type { SelectionCandidate } from '$lib/document/selection/selection-model';
	import { immutable } from '../../immutable';
	import { semanticConcession } from '../../playbook/content';
	import { useQuery, useConvexClient } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import type { DocumentSourceInput } from '$lib/document/runtime/source.svelte';
	import type { AuthoringOutcome } from '$lib/playbook/authoring-controller.svelte';
	import { getTemplateAuthoringSession } from '$lib/playbook/template-authoring-session.svelte';
	import { getDocumentResources } from '$lib/document/runtime/resources.svelte';
	import DocumentViewerSlot from '$lib/components/document/DocumentViewerSlot.svelte';
	import SourceSelectionToolbar from '$lib/components/document/SourceSelectionToolbar.svelte';
	import BoxDismissal from '$lib/components/playbook/BoxDismissal.svelte';
	import PlaybookEditor from '$lib/components/playbook/PlaybookEditor.svelte';
	import PlaybookCard from '$lib/components/playbook/PlaybookCard.svelte';
	import Button from '$lib/ui/Button.svelte';
	import PlaybookReadBody from '$lib/components/playbook/PlaybookReadBody.svelte';
	import WorkspaceDocumentFeedback from './WorkspaceDocumentFeedback.svelte';
	import type { TemplateRouteFrameState } from './template-route-frame';
	import { setInteractionOwner } from '$lib/components/ui/interactions';
	import InteractionInputScope from '$lib/components/ui/InteractionInputScope.svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';

	let {
		active = true,
		audience = 'rep',
		onFrame
	}: {
		active?: boolean;
		audience?: TemplateAudience;
		onFrame?: (frame: TemplateRouteFrameState) => () => void;
	} = $props();
	const buyerTemplate = untrack(() => audience === 'buyer');
	const copy = untrack(() => templateCopy(audience));
	setAnnotationLabel(buyerTemplate ? 'explanation' : 'instructions');
	const runtime = getWorkspaceRuntime();
	const accountViewer = useViewer();
	const isAdmin = $derived(accountViewer().membership.role === 'admin');
	const authoringSession = untrack(() => getTemplateAuthoringSession(audience));
	const available = $derived(
		active &&
			!runtime.paused &&
			isAdmin &&
			!authoringSession.templateSource.rejected &&
			!authoringSession.structureRejected
	);
	const session = useViewerSession();
	const membershipId = accountViewer().membership.id;
	const templateSource = authoringSession.templateSource;
	// The mounted workspace keeps its own lease, including the Settings detour.
	const releaseReads = untrack(() => authoringSession.retainReads());
	onDestroy(releaseReads);
	const client = useConvexClient();
	let copyCandidate = $state.raw<SelectionCandidate | null>(null);
	const copyTarget = $derived(copyCandidate?.target);
	const copySource = $derived(templateSource.data?.templateSourceFingerprint);
	const repSummary = useQuery(api.playbookItems.repSummary, () =>
		buyerTemplate && available && copyTarget && copySource && !session.blocked
			? { membershipId, templateSourceFingerprint: copySource, target: copyTarget }
			: 'skip'
	);
	let disposed = false;
	onDestroy(() => (disposed = true));
	async function copyRepSummary(candidate: SelectionCandidate, current: () => boolean) {
		const fingerprint = copySource;
		if (!fingerprint || !buyerTemplate) return false;
		try {
			const saved = await client.query(api.playbookItems.repSummary, {
				membershipId,
				templateSourceFingerprint: fingerprint,
				target: candidate.target
			});
			if (disposed || !available || !current() || fingerprint !== copySource) return false;
			if (!saved) {
				authoring.reportBlocked('This selection no longer has a saved rep summary to copy.');
				return false;
			}
			if (!authoring.startItemFromSelection(candidate)) return false;
			authoring.setExplanation(saved);
			return true;
		} catch {
			if (!disposed && current())
				authoring.reportBlocked('Unable to copy the rep summary. Please try again.');
			return false;
		}
	}
	const preloadTemplateSource = $derived(
		available && !session.blocked && !templateSource.error
			? (templateSource.data?.templateSourceFingerprint ?? null)
			: null
	);
	$effect(() => {
		const fingerprint = preloadTemplateSource;
		untrack(() => authoringSession.configurePreloading(fingerprint));
	});
	const itemPreload = $derived(authoringSession.itemPreload);
	const projected = $derived(authoringSession.projectedStructure);
	const details = $derived(authoringSession.hydratedDetails);
	// Buyer wording never contributes replacement content to the document renderer.
	const renderDetails = $derived(details.filter(isRepItem));
	const sourceMatches = $derived(
		Boolean(
			templateSource.data &&
			authoringSession.coherent &&
			projected &&
			templateSource.data.templateSourceFingerprint === projected.templateSourceFingerprint
		)
	);
	const data: DocumentSourceInput = $derived(
		sourceMatches && projected?.ready
			? {
					kind: 'structure',
					blocks: { data: templateSource.data?.blocks, error: templateSource.error },
					structure: { data: projected, error: authoringSession.structureError || undefined },
					details: renderDetails,
					pendingRenderKey: authoringSession.pendingRenderKey
				}
			: {
					kind: 'prose',
					blocks: { data: templateSource.data?.blocks, error: templateSource.error }
				}
	);
	onMount(recordTemplateQueryOwner);
	const resources = getDocumentResources();
	const resource = resources
		? untrack(() => resources.acquire(buyerTemplate ? 'template:buyer' : 'template', data))
		: undefined;
	let attachment =
		$state.raw<import('$lib/document/runtime/resources.svelte').DocumentAttachment>();
	$effect(() => {
		if (!resource || !resources) return;
		if (!available) return;
		const owned = untrack(() => resources.activate(resource));
		attachment = owned;
		return () => {
			owned.release();
			attachment = undefined;
		};
	});
	const interactionOwner = setInteractionOwner(resource?.owner ?? Symbol('authoring-workspace'));
	const workspace = setDocumentWorkspace(
		resource?.workspace ?? untrack(() => createDocumentWorkspace(data))
	);
	const { source, viewer } = workspace;
	$effect(() =>
		onFrame?.({
			audience,
			workspace,
			interactionOwner,
			available
		})
	);
	const editingUnavailableReason = $derived.by(() => {
		if (!available) return copy.unavailable;
		if (session.blocked) return 'Waiting for your account to be ready…';
		if (templateSource.error) return 'Unable to load the template. Refresh and try again.';
		if (authoringSession.structureError) return authoringSession.structureError;
		if (!authoringSession.current) return copy.refreshing;
		if (!sourceMatches) return copy.waitingSource;
		if (!source.itemsCurrent)
			return source.issue
				? 'Unable to prepare the template for editing. Refresh and try again.'
				: 'Preparing the template for editing…';
		return '';
	});
	let viewerPresentation =
		$state<import('$lib/auth/workspace-presentation.svelte').PresentationOutcome>('pending');
	const presentationOutcome = $derived(
		!authoringSession.current || !source.itemsCurrent || !sourceMatches
			? 'pending'
			: (!source.renderSource && source.issue) ||
				  (viewerPresentation === 'error' &&
						(workspace.renderer.error || viewer.preparationBlocked))
				? 'error'
				: viewerPresentation === 'success' &&
					  source.renderSource &&
					  !workspace.renderer.error &&
					  !viewer.preparationBlocked &&
					  viewer.layoutPrepared &&
					  viewer.pagesVisible &&
					  viewer.displayedSnapshot &&
					  viewer.displayedSnapshot === workspace.renderer.snapshot &&
					  viewer.displayedSnapshot.source === source.renderSource
					? 'success'
					: 'pending'
	);
	$effect(() => {
		if (viewerPresentation === 'success' && source.renderReady)
			untrack(() => authoringSession.presented());
	});

	authoringSession.installController(AuthoringController);
	const authoring = authoringSession.controller;
	onMount(() => {
		if (!isAdmin) return;
		return authoringSession.attach(() => ({
			document: source.compiled,
			geometry: source.geometry,
			items: source.structuralItems,
			itemsCurrent: source.itemsCurrent && authoringSession.current && sourceMatches,
			addresses: viewer.displayedSnapshot?.addresses,
			selectionContext:
				viewer.interactionEnabled &&
				source.itemsCurrent &&
				sourceMatches &&
				viewer.displayedSnapshot?.source === source.renderSource &&
				viewer.displayedSnapshot?.source.sourceIndex === source.compiled?.index
					? viewer.displayedSnapshot?.selectionDocument
					: undefined,
			lookup: (id) => {
				const record = authoringSession.detail(id);
				const annotations = source.annotations.find((item) => item.itemId === id)?.annotations;
				return record && annotations ? { record, annotations } : null;
			},
			detailStatus: (id) => authoringSession.detailStatus(id),
			editingUnavailableReason,
			editingAvailable:
				available &&
				!session.blocked &&
				source.itemsCurrent &&
				authoringSession.current &&
				sourceMatches &&
				!templateSource.error,
			available:
				available &&
				!session.blocked &&
				viewer.interactionEnabled &&
				source.itemsCurrent &&
				authoringSession.current &&
				sourceMatches &&
				!templateSource.error
		}));
	});
	$effect(() => {
		if (runtime.paused) return;
		void source.compiled;
		void source.geometry;
		void source.geometryVersion;
		void source.structuralItems;
		void source.itemsCurrent;
		void details;
		void authoring.entry;
		void viewer.interactionEnabled;
		untrack(() => authoringSession.acceptSource());
	});
	$effect(() => {
		if (runtime.paused) return;
		workspace.accept(data);
		recordTemplateSourceUpdate();
	});
	const projectionMatches = $derived(source.compactStructure && sourceMatches);
	const entry = $derived(
		projectionMatches && authoringSession.entryMatchesSource ? authoring.entry : null
	);
	const pendingPanel = $derived(projectionMatches ? authoringSession.pendingPanel : null);
	let animateEditorContent = $state(false);
	let previousEditorEntry: object | null = null;
	$effect(() => {
		const currentEntry = entry;
		animateEditorContent = Boolean(
			previousEditorEntry && currentEntry && previousEditorEntry !== currentEntry
		);
		previousEditorEntry = currentEntry;
	});
	const draft = $derived(authoring.draft);
	const previewConcession = $derived(
		authoring.creationConcession ??
			(draft && isRepItem(draft)
				? draft.concessions.find((concession) => concession.id === authoring.previewConcessionId)
				: undefined)
	);
	const previewChanges = $derived(
		previewConcession
			? immutable(
					semanticConcession(previewConcession).changes.filter((change) =>
						change.replacement.some(
							(atom) =>
								atom.kind === 'reference' || (atom.kind === 'text' && Boolean(atom.text.trim()))
						)
					)
				)
			: EMPTY_PREVIEW_CHANGES
	);
	function isSelectedInsertionBoundary(range: SourceTarget) {
		const index = viewer.displayedSnapshot?.source.sourceIndex;
		if (!index) return false;
		try {
			return Boolean(structuralBoundary(index, range));
		} catch {
			return false;
		}
	}
	// Text selections yield to their replacement preview; insertion boundaries stay visibly selected.
	const authoringHighlightRanges = $derived(
		authoring.selectedRanges.filter(
			(range) =>
				isSelectedInsertionBoundary(range) ||
				!previewChanges.some((change) => sameSourceTarget(range, change.target))
		)
	);
	/** Restore the captured annotation only when an action actually closes the editor. */
	async function runEditorAction(action: () => AuthoringOutcome, restoreFocus = true) {
		const restore = restoreFocus ? viewer.captureAnnotationFocus?.() : undefined;
		if (action() !== 'closed' || authoring.entry) return;
		await tick();
		if (!authoring.entry) restore?.();
	}
	let pendingRestoreFocus: (() => void) | undefined;
	$effect(() => {
		if (!pendingPanel) pendingRestoreFocus = undefined;
	});
	function selectItem(itemId: string, annotationId: string) {
		const restore = pendingPanel
			? pendingRestoreFocus
			: entry
				? viewer.captureAnnotationFocus?.()
				: undefined;
		const admission = authoringSession.select(itemId, annotationId);
		if (admission.status === 'accepted')
			pendingRestoreFocus = authoringSession.pendingPanel ? restore : undefined;
		return admission;
	}
	async function dismissPending(restoreFocus: boolean) {
		const restore = pendingRestoreFocus ?? viewer.captureAnnotationFocus?.();
		const previousEntry = authoring.entry;
		if (!authoringSession.cancelSelection()) return;
		pendingRestoreFocus = undefined;
		await tick();
		if (restoreFocus && !authoringSession.selectionRequest && authoring.entry === previousEntry)
			restore?.();
	}
	function cancel() {
		if (pendingPanel) {
			void dismissPending(true);
			return;
		}
		void runEditorAction(() => authoring.cancel());
	}
	function dismiss(restoreFocus = false) {
		if (pendingPanel) {
			void dismissPending(restoreFocus);
			return;
		}
		void runEditorAction(() => authoring.dismissFromOutside(), restoreFocus);
	}
	function remove() {
		if (!authoring.canDelete) return;
		if (!window.confirm(copy.deleteConfirm)) return;
		void runEditorAction(() => authoring.remove());
	}
	function restoreSubmittedDraft() {
		const replace = authoring.hasUnsavedWork;
		if (
			replace &&
			!window.confirm('Replace your current unsaved draft with the retained submitted draft?')
		)
			return;
		authoringSession.restore(replace);
	}
	beforeNavigate((navigation) => {
		if (session.closing) return;
		if (session.blocked && !navigation.willUnload) {
			navigation.cancel();
			return;
		}
		// Document unload uses the browser warning below, without discarding first.
		if (navigation.willUnload) return;
		const target = navigation.to?.route.id;
		// The temporary Settings detour does not abandon or retry local work.
		if (
			target === (buyerTemplate ? '/(workspace)/template/buyers' : '/(workspace)/template') &&
			page.route.id === '/(workspace)/settings'
		)
			return;
		if (target === '/(workspace)/settings' && (runtime.paused || !active)) return;
		const decision = authoring.assess({ kind: 'leave' });
		if (decision.kind === 'blocked') {
			navigation.cancel();
			authoring.reportBlocked(decision.message);
			return;
		}
		if (decision.kind === 'confirm-discard' && !window.confirm(decision.message)) {
			navigation.cancel();
			return;
		}
		if (!authoring.leave(true)) navigation.cancel();
	});
</script>

<WorkspacePresentationReporter
	active={active && !runtime.paused}
	outcome={isAdmin ? presentationOutcome : 'success'}
/>
{#if active && !runtime.paused && !isAdmin}
	<p role="alert" class="px-6 py-8 text-sm text-ink-muted">
		{copy.denied}
	</p>
{/if}

{#if active && isAdmin && (templateSource.rejected || authoringSession.structureRejected)}
	<p role="alert" class="px-6 py-4 text-sm text-danger">
		Unable to load this template. <button
			class="underline"
			onclick={() => authoringSession.retryReads()}>Try again</button
		>
	</p>
{/if}

<BoxDismissal
	owner={interactionOwner}
	active={available && Boolean(entry || pendingPanel)}
	onDismiss={dismiss}
/>

<div hidden={!available} inert={!available} aria-hidden={!available}>
	{#if available}<WorkspaceDocumentFeedback {workspace} />{/if}
	{#if available}
		{#if !authoringSession.entryMatchesSource && authoring.hasUnsavedWork}
			<div role="status" class="mx-auto max-w-3xl px-6 py-3 text-sm">
				<p>The template source changed. Your previous draft is retained separately.</p>
				<button
					class="mt-2 underline"
					onclick={() => {
						if (window.confirm(copy.leaveConfirm)) {
							authoring.discard();
							authoringSession.acceptSource();
						}
					}}>Discard previous draft</button
				>
			</div>
		{/if}

		{#if authoringSession.phase === 'uncertain'}
			<div class="mx-auto max-w-3xl px-6 py-3 text-sm" role="alert">
				<p>{authoringSession.message}</p>
				<button
					type="button"
					class="mt-2 underline disabled:text-ink-muted"
					disabled={session.blocked}
					onclick={() => authoringSession.retry()}>Retry confirmation</button
				>
			</div>
		{/if}
		{#if templateSource.error || authoringSession.structureError || (authoringSession.detailError && !pendingPanel?.error)}<div
				class="mx-auto max-w-3xl px-6 text-sm text-danger"
				role="status"
			>
				<p>
					{templateSource.error
						? 'Unable to refresh the template. Please try again.'
						: authoringSession.structureError || authoringSession.detailError}
				</p>
				<button type="button" class="underline" onclick={() => authoringSession.retryReads()}
					>Retry refresh</button
				>
			</div>{/if}
		{#if authoringSession.phase === 'recovery'}
			<div class="mx-auto max-w-3xl px-6 py-3 text-sm" role="status">
				<p>{authoringSession.message}</p>
				<button
					type="button"
					class="mt-2 underline disabled:opacity-50"
					disabled={!authoringSession.recoveryCanRestore}
					onclick={restoreSubmittedDraft}>Restore submitted draft</button
				>
				<button
					type="button"
					class="ml-4 underline"
					onclick={() => {
						if (window.confirm(copy.discardRetainedConfirm)) authoringSession.discardRecovery();
					}}>Discard draft</button
				>
			</div>
		{/if}
	{/if}
	{#if source.renderSource || !source.issue}
		<InteractionInputScope capture={recordDocumentInput}>
			<main
				oninputcapture={recordDocumentInput}
				onclickcapture={recordDocumentInput}
				class="template-selection-enabled pb-12 [--workspace-loading-inset:calc(var(--spacing)*16+var(--mobile-utility-rail-height))] min-[1000px]:[--workspace-loading-inset:calc(var(--spacing)*27)]"
				aria-label="Template editor"
			>
				{#snippet panelContent()}
					{#if source.renderSource && (pendingPanel || entry)}
						<PlaybookCard label={copy.editorLabel}>
							{#if pendingPanel}
								<div aria-busy={!pendingPanel.error} aria-label={copy.loading} class="grid gap-3">
									<h2 class="text-sm font-medium">{copy.editingTitle}</h2>
									{#if pendingPanel.body}<PlaybookReadBody item={pendingPanel.body} />{/if}
									{#if pendingPanel.error}
										<p role="status" class="text-[13px] leading-relaxed text-ink-muted">
											{copy.loadFailureHint}
										</p>
									{/if}
								</div>
								<div class="flex justify-end gap-2">
									<Button variant="secondary" onclick={cancel}>Close</Button>
									{#if pendingPanel.error}<Button onclick={() => authoringSession.retryReads()}
											>Try again</Button
										>{/if}
								</div>
							{:else if entry}
								<PlaybookEditor
									embedded
									controller={authoring}
									animateContent={animateEditorContent}
									onCancel={cancel}
									onPrimary={() => runEditorAction(() => authoring.primary())}
									onDelete={remove}
								/>
							{/if}
						</PlaybookCard>
					{/if}
				{/snippet}
				{#if !entry && authoring.feedback}<p
						class="mx-auto max-w-3xl px-6 text-sm text-danger"
						role="status"
					>
						{authoring.feedback}
					</p>{/if}
				<DocumentViewerSlot
					{attachment}
					entry={resource}
					active={available}
					onPresentation={(outcome) => (viewerPresentation = outcome)}
					prepare={!runtime.paused && source.renderReady}
					{itemPreload}
					interactive={available}
					hasPanel={Boolean(entry || pendingPanel)}
					followScroll={projectionMatches &&
						authoringSession.entryMatchesSource &&
						authoring.locationPicking}
					{panelContent}
					selectedAnnotationId={pendingPanel?.annotationId ??
						(entry ? authoring.selectedAnnotationId : undefined)}
					selectionRequest={projectionMatches ? authoringSession.selectionRequest : null}
					selectedRanges={projectionMatches && authoringSession.entryMatchesSource
						? authoringHighlightRanges
						: []}
					previewChanges={projectionMatches && authoringSession.entryMatchesSource
						? previewChanges
						: EMPTY_PREVIEW_CHANGES}
					selectedConcessions={{}}
					onRemoveConcession={() => authoring.clearPreview()}
					panelTarget={projectionMatches && authoringSession.entryMatchesSource
						? (pendingPanel?.target ?? draft?.trigger.target)
						: undefined}
					picking={projectionMatches &&
						authoringSession.entryMatchesSource &&
						authoring.locationPicking}
					sourceSelectionEnabled={projectionMatches &&
						authoringSession.entryMatchesSource &&
						authoring.textSelectionEnabled &&
						!pendingPanel}
					allowPlaybookNavigation={true}
					playbookNavigationReady={projectionMatches}
					onSelect={selectItem}
					onDocumentBackground={() => dismiss(false)}
				/>
			</main>
		</InteractionInputScope>
		{#if available && viewer.interactionEnabled && viewer.displayedSnapshot}<SourceSelectionToolbar
				{audience}
				container={viewer.documentStageElement ?? undefined}
				snapshot={viewer.displayedSnapshot}
				enabled={projectionMatches &&
					authoringSession.entryMatchesSource &&
					authoring.textSelectionEnabled &&
					!pendingPanel}
				autoConfirm={authoring.textSelectionAutoConfirm}
				onSelectionIssue={(issue) => authoring.reportIssue(issue)}
				onActionBlocked={(reason) => authoring.reportBlocked(reason)}
				onGestureStart={() => authoring.clearFeedback()}
				evaluate={(candidate) =>
					buyerTemplate && candidate.target.kind !== 'text'
						? { allowed: false, reason: 'Select the text you want to explain to buyers.' }
						: authoring.selectionEligibility(candidate)}
				onCandidate={(candidate) => (copyCandidate = candidate)}
				copyRepSummary={buyerTemplate
					? {
							enabled: Boolean(repSummary.data),
							reason: 'Select text within a rep clause with a saved summary to copy it.',
							run: copyRepSummary
						}
					: undefined}
				onConfirm={(range, mode) => {
					if (mode === 'add-item') return authoring.startItemFromSelection(range);
					if (mode === 'concession') return authoring.startConcessionFromSelection(range);
					return authoring.textSelectionPurpose === 'secondary-location'
						? authoring.attachSecondaryLocation(range)
						: authoring.startConcessionFromSelection(range);
				}}
			/>{/if}
	{:else}<p role="alert">We couldn’t load this template. Please refresh to try again.</p>{/if}
</div>
