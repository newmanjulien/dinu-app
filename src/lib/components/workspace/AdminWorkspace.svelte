<script lang="ts">
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { untrack, onMount, tick } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { getWorkspaceRuntime } from '$lib/auth/workspace-context.svelte';
	import { createContractWorkspace } from '$lib/document/runtime/workspace-factory';
	import { setContractWorkspace } from '$lib/document/runtime/workspace-context';
	import {
		recordAdminQueryOwner,
		recordAdminSourceUpdate,
		recordContractInput
	} from '$lib/document/runtime/render-perf';
	import { EMPTY_PREVIEW_CHANGES } from '$lib/document/runtime/types';
	import { sameSourceTarget } from '$lib/contract/source-model';
	import { structuralBoundary } from '$lib/contract/ranges';
	import type { SourceTarget } from '$lib/playbook/model';
	import { immutable } from '../../immutable';
	import { semanticConcession } from '../../playbook/content';
	import { useQuery } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import type { ContractSourceInput } from '$lib/document/runtime/source.svelte';
	import type { AuthoringOutcome } from '$lib/playbook/authoring-controller.svelte';
	import { getAdminAuthoringSession } from '$lib/playbook/admin-authoring-session.svelte';
	import { getDocumentResources } from '$lib/document/runtime/resources.svelte';
	import DocumentViewerSlot from '$lib/components/document/DocumentViewerSlot.svelte';
	import SourceSelectionToolbar from '$lib/components/document/SourceSelectionToolbar.svelte';
	import BoxDismissal from '$lib/components/playbook/BoxDismissal.svelte';
	import PlaybookEditor from '$lib/components/playbook/PlaybookEditor.svelte';
	import PlaybookCard from '$lib/components/playbook/PlaybookCard.svelte';
	import WorkspaceChrome from './WorkspaceChrome.svelte';
	import { setInteractionOwner } from '$lib/components/ui/interactions';
	import InteractionInputScope from '$lib/components/ui/InteractionInputScope.svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';

	let { active = true }: { active?: boolean } = $props();
	const runtime = getWorkspaceRuntime();
	const available = $derived(active && !runtime.paused);
	const authoringSession = getAdminAuthoringSession();
	const session = useViewerSession();
	const accountViewer = useViewer();
	const membershipId = accountViewer().membership.id;
	const baseline = useQuery(api.baselines.authoringSource, () =>
		runtime.paused ? 'skip' : { membershipId }
	);
	const preloadBaseline = $derived(
		available && !session.blocked && !baseline.error
			? (baseline.data?.baselineFingerprint ?? null)
			: null
	);
	$effect(() => {
		const fingerprint = preloadBaseline;
		untrack(() => authoringSession.configurePreloading(fingerprint));
	});
	const instructionPreload = $derived(authoringSession.instructionPreload);
	const projected = $derived(authoringSession.projectedStructure);
	const details = $derived(authoringSession.hydratedDetails);
	const sourceMatches = $derived(
		Boolean(
			baseline.data &&
			projected &&
			baseline.data.baselineFingerprint === projected.baselineFingerprint
		)
	);
	const data: ContractSourceInput = {
		blocks: {
			get data() {
				return sourceMatches ? baseline.data?.blocks : undefined;
			},
			get error() {
				return baseline.error;
			}
		},
		items: {},
		structure: {
			get data() {
				return sourceMatches ? (projected ?? undefined) : undefined;
			},
			get error() {
				return authoringSession.structureError || undefined;
			}
		},
		get details() {
			return details;
		},
		get pendingRenderKey() {
			return authoringSession.pendingRenderKey;
		}
	};
	onMount(recordAdminQueryOwner);
	const resources = getDocumentResources();
	const resource = resources ? untrack(() => resources.acquire('admin', data)) : undefined;
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
	const workspace = setContractWorkspace(
		resource?.workspace ?? untrack(() => createContractWorkspace(data))
	);
	const { source, viewer } = workspace;
	const editingUnavailableReason = $derived.by(() => {
		if (!available) return 'Instruction editing is temporarily unavailable.';
		if (session.blocked) return 'Waiting for your account to be ready…';
		if (baseline.error) return 'Unable to load the contract. Refresh and try again.';
		if (authoringSession.structureError) return authoringSession.structureError;
		if (!authoringSession.current) return 'Refreshing instructions…';
		if (!sourceMatches) return 'Waiting for instructions to match the uploaded contract…';
		if (!source.itemsCurrent)
			return source.issue
				? 'Unable to prepare the contract for editing. Refresh and try again.'
				: 'Preparing the contract for editing…';
		return '';
	});
	let viewerPresentation =
		$state<import('$lib/auth/workspace-presentation.svelte').PresentationOutcome>('pending');
	const presentationOutcome = $derived(
		(!source.renderSource && source.issue) ||
			(viewerPresentation === 'error' && (workspace.renderer.error || viewer.preparationBlocked))
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
	const authoring = authoringSession.controller;
	onMount(() =>
		authoringSession.attach(() => ({
			contract: source.compiled,
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
				!baseline.error,
			available:
				available &&
				!session.blocked &&
				viewer.interactionEnabled &&
				source.itemsCurrent &&
				authoringSession.current &&
				sourceMatches &&
				!baseline.error
		}))
	);
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
		recordAdminSourceUpdate();
	});
	const entry = $derived(authoring.entry);
	const pendingPanel = $derived(authoringSession.pendingPanel);
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
			draft?.concessions.find((concession) => concession.id === authoring.previewConcessionId)
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
	function selectInstruction(itemId: string, annotationId: string) {
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
		if (
			!window.confirm(
				'Permanently delete this instruction box? Any unsaved local edits will also be discarded.'
			)
		)
			return;
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
		if (target === '/(workspace)/admin' && page.route.id === '/(workspace)/settings') return;
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

<WorkspacePresentationReporter active={available} outcome={presentationOutcome} />

<BoxDismissal
	owner={interactionOwner}
	active={available && Boolean(entry || pendingPanel)}
	onDismiss={dismiss}
/>

<div hidden={!available} inert={!available} aria-hidden={!available}>
	{#if available}
		<WorkspaceChrome helpVariant="admin" helpReady={viewer.layoutPrepared} />
		{#if authoringSession.structureError || (authoringSession.detailError && !pendingPanel?.error)}<div
				class="mx-auto max-w-3xl px-6 text-sm text-danger"
				role="status"
			>
				<p>{authoringSession.structureError || authoringSession.detailError}</p>
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
						if (window.confirm('Discard the retained instruction draft?'))
							authoringSession.discardRecovery();
					}}>Discard draft</button
				>
			</div>
		{/if}
	{/if}
	{#if source.renderSource || !source.issue}
		<InteractionInputScope capture={recordContractInput}>
			<main
				oninputcapture={recordContractInput}
				onclickcapture={recordContractInput}
				class="admin-selection-enabled pt-2 pb-12 [--workspace-loading-inset:calc(var(--spacing)*16+var(--mobile-utility-rail-height))] min-[1000px]:pt-5 min-[1000px]:[--workspace-loading-inset:calc(var(--spacing)*27)]"
				aria-label="Contract authoring"
			>
				<h1
					class="mb-2 grid min-h-(--mobile-utility-rail-height) place-items-center px-2 text-center text-[13px] leading-6 text-ink-muted min-[1000px]:mb-4 min-[1000px]:block min-[1000px]:min-h-0"
				>
					Edit the instructions reps see
				</h1>
				{#snippet panelContent()}
					{#if source.renderSource && pendingPanel}
						<PlaybookCard label="Instruction box editor">
							<div aria-busy={!pendingPanel.error} class="grid gap-3">
								{#if pendingPanel.error}
									<p class="text-danger" role="status">{pendingPanel.error}</p>
									<button
										type="button"
										class="text-left underline"
										onclick={() => authoringSession.retryReads()}>Retry refresh</button
									>
								{:else}
									<div aria-hidden="true" class="grid gap-3 motion-safe:animate-pulse">
										<div class="h-4 w-4/5 rounded bg-edge"></div>
										<div class="h-24 rounded bg-edge/50"></div>
										<div class="h-4 w-3/5 rounded bg-edge"></div>
									</div>
								{/if}
							</div>
							<button
								type="button"
								class="self-end text-sm text-ink-muted underline"
								onclick={cancel}>Close</button
							>
						</PlaybookCard>
					{:else if source.renderSource && entry}
						<PlaybookEditor
							controller={authoring}
							animateContent={animateEditorContent}
							onCancel={cancel}
							onPrimary={() => runEditorAction(() => authoring.primary())}
							onDelete={remove}
						/>
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
					prepare={!runtime.paused}
					{instructionPreload}
					interactive={available}
					hasPanel={Boolean(entry || pendingPanel)}
					followScroll={authoring.locationPicking}
					{panelContent}
					selectedAnnotationId={pendingPanel?.annotationId ?? authoring.selectedAnnotationId}
					selectionRequest={authoringSession.selectionRequest}
					selectedRanges={authoringHighlightRanges}
					{previewChanges}
					selectedConcessions={{}}
					onRemoveConcession={() => authoring.clearPreview()}
					panelTarget={pendingPanel?.target ?? draft?.trigger.target}
					picking={authoring.locationPicking}
					sourceSelectionEnabled={authoring.textSelectionEnabled && !pendingPanel}
					allowPlaybookNavigation={true}
					playbookNavigationReady={authoringSession.current && source.itemsCurrent && sourceMatches}
					onSelect={selectInstruction}
					onDocumentBackground={() => dismiss(false)}
				/>
			</main>
		</InteractionInputScope>
		{#if available && viewer.interactionEnabled && viewer.displayedSnapshot}<SourceSelectionToolbar
				container={viewer.documentStageElement}
				snapshot={viewer.displayedSnapshot}
				enabled={authoring.textSelectionEnabled && !pendingPanel}
				autoConfirm={authoring.textSelectionAutoConfirm}
				onSelectionIssue={(issue) => authoring.reportIssue(issue)}
				onActionBlocked={(reason) => authoring.reportBlocked(reason)}
				onGestureStart={() => authoring.clearFeedback()}
				evaluate={(range) => authoring.selectionEligibility(range)}
				onConfirm={(range, mode) => {
					if (mode === 'explain') return authoring.startExplanationFromSelection(range);
					if (mode === 'concession') return authoring.startConcessionFromSelection(range);
					return authoring.textSelectionPurpose === 'secondary-location'
						? authoring.attachSecondaryLocation(range)
						: authoring.startConcessionFromSelection(range);
				}}
			/>{/if}
	{:else}<p role="alert">We couldn’t load this contract. Please refresh to try again.</p>{/if}
</div>
