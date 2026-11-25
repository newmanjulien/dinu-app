<script lang="ts">
	import { AuthoringController } from '$lib/playbook/authoring-controller.svelte';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { untrack, onMount, onDestroy, tick } from 'svelte';
	import { afterNavigate, beforeNavigate, goto } from '$app/navigation';
	import type { BeforeNavigate } from '@sveltejs/kit';
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
	import { immutable } from '../../immutable';
	import { semanticConcession } from '../../playbook/content';
	import type { DocumentSourceInput } from '$lib/document/runtime/source.svelte';
	import type { AuthoringOutcome } from '$lib/playbook/authoring-controller.svelte';
	import { getTemplateAuthoringSession } from '$lib/playbook/template-authoring-session.svelte';
	import { getDocumentResources } from '$lib/document/runtime/resources.svelte';
	import DocumentViewerSlot from '$lib/components/document/DocumentViewerSlot.svelte';
	import SourceSelectionToolbar from '$lib/components/document/SourceSelectionToolbar.svelte';
	import BoxDismissal from '$lib/components/playbook/BoxDismissal.svelte';
	import PlaybookEditor from '$lib/components/playbook/PlaybookEditor.svelte';
	import DocumentPanelCard from '$lib/components/document/DocumentPanelCard.svelte';
	import DocumentPanelBody from '$lib/components/document/DocumentPanelBody.svelte';
	import Button from '$lib/ui/Button.svelte';
	import ConfirmModal from '$lib/ui/ConfirmModal.svelte';
	import PlaybookReadBody from '$lib/components/playbook/PlaybookReadBody.svelte';
	import WorkspaceDocumentFeedback from './WorkspaceDocumentFeedback.svelte';
	import type { TemplateRouteFrameState } from './template-route-frame';
	import { setInteractionOwner } from '$lib/components/ui/interactions';
	import InteractionInputScope from '$lib/components/ui/InteractionInputScope.svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';

	let {
		active = true,
		audience,
		onFrame
	}: {
		active?: boolean;
		audience: TemplateAudience;
		onFrame?: (frame: TemplateRouteFrameState) => () => void;
	} = $props();
	const buyerTemplate = untrack(() => audience === 'buyer');
	const copy = untrack(() => templateCopy(audience));
	setAnnotationLabel(buyerTemplate ? 'explanation' : 'instructions');
	const runtime = getWorkspaceRuntime();
	const accountViewer = useViewer();
	const canManageTemplate = $derived(accountViewer().permissions.manageTemplate);
	const authoringSession = untrack(() => getTemplateAuthoringSession(audience));
	const available = $derived(
		active &&
			!runtime.paused &&
			canManageTemplate &&
			!authoringSession.templateSource.rejected &&
			!authoringSession.structureRejected
	);
	const session = useViewerSession();
	const templateSource = authoringSession.templateSource;
	// The mounted workspace keeps its own lease, including the Settings detour.
	const releaseReads = untrack(() => authoringSession.retainReads());
	onDestroy(releaseReads);
	let disposed = false;
	onDestroy(() => (disposed = true));
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
	type ConfirmationRequest = {
		title: string;
		message: string;
		confirmLabel: string;
		destructive?: boolean;
		error?: string;
		onConfirm: () => void | Promise<void>;
	};
	let confirmation = $state.raw<ConfirmationRequest | null>(null);
	let approvedLeave: {
		from: string;
		to: string;
		type: 'goto' | 'popstate';
		delta?: number;
	} | null = null;
	let stopWaitingForHistory: (() => void) | undefined;
	onDestroy(() => stopWaitingForHistory?.());
	afterNavigate(() => {
		confirmation = null;
		stopWaitingForHistory?.();
		stopWaitingForHistory = undefined;
	});
	async function confirmRequestedAction() {
		const request = confirmation;
		if (!request) return;
		const from = page.url.href;
		confirmation = null;
		await tick();
		try {
			await request.onConfirm();
		} catch {
			if (!disposed && page.url.href === from && confirmation === null)
				confirmation = {
					...request,
					error: 'We couldn’t complete this action. Please try again.'
				};
		}
	}
	onMount(() => {
		if (!canManageTemplate) return;
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
	const locationPicking = $derived(
		projectionMatches && authoringSession.entryMatchesSource && authoring.pickingSecondaryLocation
	);
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
		authoring.concessionComposer ??
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
	let editor = $state<PlaybookEditor>();
	/** Restore annotation focus on panel close, or concession button focus when backing out of the composer. */
	async function runEditorAction(action: () => AuthoringOutcome, restoreFocus = true) {
		const returnTier = authoring.concessionComposer?.tier;
		const restore = restoreFocus ? viewer.captureAnnotationFocus?.() : undefined;
		const outcome = action();
		if (outcome === 'closed') {
			if (authoring.entry) return;
			await tick();
			if (!authoring.entry) restore?.();
			return;
		}
		if (restoreFocus && returnTier && !authoring.addingConcession) {
			await tick();
			editor?.focusAddConcession(returnTier);
		}
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
	function dismiss(restoreFocus = false) {
		if (pendingPanel) {
			void dismissPending(restoreFocus);
			return;
		}
		void runEditorAction(() => authoring.cancel(), restoreFocus);
	}
	function remove() {
		if (!authoring.canDelete) return;
		const target = authoring.entry;
		confirmation = {
			title: copy.deleteAction,
			message: copy.deleteConfirm,
			confirmLabel: copy.deleteAction,
			destructive: true,
			onConfirm: () => {
				if (authoring.entry === target && authoring.canDelete)
					return runEditorAction(() => authoring.remove());
			}
		};
	}
	function restoreSubmittedDraft() {
		const replace = authoring.hasUnsavedWork;
		if (!replace) {
			authoringSession.restore(false);
			return;
		}
		const target = authoring.entry;
		confirmation = {
			title: 'Replace unsaved draft?',
			message: 'Replace your current unsaved draft with the retained submitted draft?',
			confirmLabel: 'Replace draft',
			destructive: true,
			onConfirm: () => {
				if (
					authoring.entry === target &&
					authoringSession.phase === 'recovery' &&
					authoringSession.recoveryCanRestore
				)
					authoringSession.restore(true);
			}
		};
	}
	function discardPreviousDraft() {
		const target = authoring.entry;
		confirmation = {
			title: 'Discard previous draft?',
			message: copy.discardPreviousConfirm,
			confirmLabel: 'Discard draft',
			destructive: true,
			onConfirm: () => {
				if (
					authoring.entry === target &&
					!authoringSession.entryMatchesSource &&
					authoring.hasUnsavedWork
				) {
					authoring.discard();
					authoringSession.acceptSource();
				}
			}
		};
	}
	function discardRetainedDraft() {
		confirmation = {
			title: 'Discard retained draft?',
			message: copy.discardRetainedConfirm,
			confirmLabel: 'Discard draft',
			destructive: true,
			onConfirm: () => {
				if (authoringSession.phase === 'recovery') authoringSession.discardRecovery();
			}
		};
	}
	function requestLeaveConfirmation(navigation: BeforeNavigate, message: string) {
		const from = navigation.from?.url.href;
		const to = navigation.to?.url.href;
		navigation.cancel();
		if (!from || !to) return;
		confirmation = null;
		stopWaitingForHistory?.();
		stopWaitingForHistory = undefined;
		const popstate = navigation.type === 'popstate';
		const delta = popstate ? navigation.delta : undefined;
		const request: ConfirmationRequest = {
			title: 'Leave without saving?',
			message,
			confirmLabel: 'Discard and leave',
			destructive: true,
			onConfirm: async () => {
				if (page.url.href !== from || session.blocked || session.closing) return;
				approvedLeave = { from, to, type: popstate ? 'popstate' : 'goto', delta };
				if (popstate) {
					window.history.go(delta);
				} else {
					try {
						await goto(to);
					} finally {
						approvedLeave = null;
					}
				}
			}
		};
		if (!popstate) {
			confirmation = request;
			return;
		}
		// Kit reverses a cancelled popstate asynchronously. Replay only after it restores this entry.
		const restored = () => {
			if (window.location.href !== from) return;
			stopWaitingForHistory?.();
			stopWaitingForHistory = undefined;
			confirmation = request;
		};
		window.addEventListener('popstate', restored);
		stopWaitingForHistory = () => window.removeEventListener('popstate', restored);
	}
	beforeNavigate((navigation) => {
		const approval = approvedLeave;
		approvedLeave = null;
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
		if (decision.kind === 'confirm-discard') {
			const approved =
				approval !== null &&
				approval.from === navigation.from?.url.href &&
				approval.to === navigation.to?.url.href &&
				approval.type === navigation.type &&
				(navigation.type !== 'popstate' || approval.delta === navigation.delta);
			if (!approved) {
				requestLeaveConfirmation(navigation, decision.message);
				return;
			}
		}
		if (!authoring.leave(true)) navigation.cancel();
	});
</script>

{#if confirmation}
	<ConfirmModal
		portal
		title={confirmation.title}
		message={confirmation.message}
		confirmLabel={confirmation.confirmLabel}
		destructive={confirmation.destructive}
		error={confirmation.error}
		onConfirm={confirmRequestedAction}
		onCancel={() => (confirmation = null)}
	/>
{/if}

<WorkspacePresentationReporter
	active={active && !runtime.paused}
	outcome={canManageTemplate ? presentationOutcome : 'pending'}
/>

{#if active && canManageTemplate && (templateSource.rejected || authoringSession.structureRejected)}
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
	dismissOnOutsidePointer={!locationPicking}
	onDismiss={dismiss}
/>

<div hidden={!available} inert={!available} aria-hidden={!available}>
	{#if available}<WorkspaceDocumentFeedback {workspace} />{/if}
	{#if available}
		{#if !authoringSession.entryMatchesSource && authoring.hasUnsavedWork}
			<div role="status" class="mx-auto max-w-3xl px-6 py-3 text-sm">
				<p>The template source changed. Your previous draft is retained separately.</p>
				<button class="mt-2 underline" onclick={discardPreviousDraft}>Discard previous draft</button
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
		{#if templateSource.error || authoringSession.structureError || authoringSession.detailError || pendingPanel?.error}<div
				class="mx-auto max-w-3xl px-6 text-sm text-danger"
				role="status"
			>
				<p>
					{templateSource.error
						? 'Unable to refresh the template. Please try again.'
						: pendingPanel?.error
							? copy.loadFailureHint
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
				<button type="button" class="ml-4 underline" onclick={discardRetainedDraft}
					>Discard draft</button
				>
			</div>
		{/if}
	{/if}
	{#if source.renderSource || !source.issue}
		<InteractionInputScope capture={recordDocumentInput}>
			<main
				oninputcapture={recordDocumentInput}
				onclickcapture={recordDocumentInput}
				class="template-selection-enabled [--document-section-bottom-padding:48px] [--workspace-loading-inset:calc(var(--spacing)*16+var(--mobile-utility-rail-height))] min-[1000px]:[--workspace-loading-inset:calc(var(--spacing)*27)]"
				aria-label="Template editor"
			>
				{#snippet panelContent()}
					{#if source.renderSource && (pendingPanel || entry)}
						<DocumentPanelCard label={copy.editorLabel} viewportScrollable={locationPicking}>
							<DocumentPanelBody>
								{#if pendingPanel}
									<div aria-busy={!pendingPanel.error} aria-label={copy.loading} class="grid gap-3">
										<h2 class="text-sm font-medium">{copy.editingTitle}</h2>
										{#if pendingPanel.body}<PlaybookReadBody item={pendingPanel.body} />{/if}
									</div>
									<div class="flex justify-end gap-2">
										<Button variant="secondary" onclick={() => dismiss(true)}>Close</Button>
										{#if pendingPanel.error}<Button onclick={() => authoringSession.retryReads()}
												>Try again</Button
											>{/if}
									</div>
								{:else if entry}
									<PlaybookEditor
										bind:this={editor}
										controller={authoring}
										animateContent={animateEditorContent}
										onCancel={() => dismiss(true)}
										onPrimary={() => runEditorAction(() => authoring.primary())}
										onDelete={remove}
									/>
								{/if}
							</DocumentPanelBody>
						</DocumentPanelCard>
					{/if}
				{/snippet}
				{#if authoring.feedback}<p class="mx-auto max-w-3xl px-6 text-sm text-danger" role="status">
						{authoring.feedback}
					</p>{/if}
				<div class="w-full">
					<DocumentViewerSlot
						{attachment}
						entry={resource}
						active={available}
						onPresentation={(outcome) => (viewerPresentation = outcome)}
						prepare={!runtime.paused && source.renderReady}
						{itemPreload}
						interactive={available}
						hasPanel={Boolean(entry || pendingPanel)}
						followScroll={locationPicking}
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
							? (pendingPanel?.target ?? authoring.panelTarget)
							: undefined}
						picking={locationPicking}
						sourceSelectionEnabled={projectionMatches &&
							authoringSession.entryMatchesSource &&
							authoring.textSelectionEnabled &&
							!pendingPanel}
						allowBoundarySelection={!buyerTemplate}
						allowPlaybookNavigation={true}
						playbookNavigationReady={projectionMatches}
						onSelect={selectItem}
						onDocumentBackground={locationPicking ? undefined : () => dismiss(false)}
					/>
				</div>
			</main>
		</InteractionInputScope>
		{#if available && viewer.interactionEnabled && viewer.displayedSnapshot}<SourceSelectionToolbar
				controller={authoring}
				container={viewer.documentStageElement ?? undefined}
				snapshot={viewer.displayedSnapshot}
				enabled={projectionMatches &&
					authoringSession.entryMatchesSource &&
					authoring.textSelectionEnabled &&
					!pendingPanel}
			/>{/if}
	{:else}<p role="alert">We couldn’t load this template. Please refresh to try again.</p>{/if}
</div>
