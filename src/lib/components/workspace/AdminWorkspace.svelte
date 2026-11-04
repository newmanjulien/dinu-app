<script lang="ts">
	import { untrack, onMount, onDestroy, tick } from 'svelte';
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
	import { immutable, semanticConcession } from '$lib/playbook/draft';
	import { env } from '$env/dynamic/public';
	import { useConvexClient, useQuery } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import type { ContractSourceInput } from '$lib/document/runtime/source.svelte';
	import {
		AuthoringController,
		type AuthoringOutcome
	} from '$lib/playbook/authoring-controller.svelte';
	import { convexSaveTransport } from '$lib/playbook/save-transport';
	import type { OperationStatus } from '$lib/components/chrome/operation-status';
	import { getDocumentResources } from '$lib/document/runtime/resources.svelte';
	import DocumentViewerSlot from '$lib/components/document/DocumentViewerSlot.svelte';
	import SourceSelectionToolbar from '$lib/components/document/SourceSelectionToolbar.svelte';
	import BoxDismissal from '$lib/components/playbook/BoxDismissal.svelte';
	import PlaybookEditor from '$lib/components/playbook/PlaybookEditor.svelte';
	import WorkspaceChrome from './WorkspaceChrome.svelte';
	import { setInteractionOwner } from '$lib/components/ui/interactions';
	import InteractionInputScope from '$lib/components/ui/InteractionInputScope.svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';

	let { active = true }: { active?: boolean } = $props();
	const runtime = getWorkspaceRuntime();
	const available = $derived(active && !runtime.paused);
	const client = env.PUBLIC_CONVEX_URL ? useConvexClient() : null;
	const session = useViewerSession();
	const accountViewer = useViewer();
	const membershipId = accountViewer().membership.id;
	const data: ContractSourceInput = client
		? {
				blocks: useQuery(api.contract.getBlocks, () =>
					runtime.paused ? 'skip' : { membershipId }
				),
				items: useQuery(api.playbookItems.list, () => (runtime.paused ? 'skip' : { membershipId }))
			}
		: { blocks: { error: true }, items: { error: true } };
	onMount(() => (client ? recordAdminQueryOwner() : undefined));
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
	const authoring = new AuthoringController(
		client ? convexSaveTransport(client, membershipId) : null,
		() => ({
			contract: source.compiled,
			geometry: source.geometry,
			items: source.items,
			itemsCurrent: source.itemsCurrent,
			addresses: viewer.displayedSnapshot?.addresses,
			lookup: (id) => source.lookup(id),
			available: available && viewer.ready
		})
	);
	$effect(() => {
		if (runtime.paused) return;
		const { compiled, geometry, geometryVersion, items, itemsCurrent } = source;
		void geometryVersion;
		void compiled;
		void geometry;
		void items;
		void itemsCurrent;
		untrack(() => authoring.accept());
	});
	let feedback = $state<OperationStatus | null>(null);
	$effect(() => {
		const completion = authoring.completion;
		feedback = completion
			? { message: completion.kind === 'saved' ? 'Changes saved' : 'Box deleted.' }
			: null;
		if (!completion) return;
		const timer = setTimeout(() => {
			feedback = null;
		}, 2500);
		return () => clearTimeout(timer);
	});
	$effect(() => {
		if (runtime.paused) return;
		workspace.accept(data);
		recordAdminSourceUpdate();
	});
	const entry = $derived(authoring.entry);
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
	onMount(() =>
		session.registerEditor({
			get pending() {
				return authoring.hasUnsavedWork;
			},
			flush: async () => (runtime.paused ? !authoring.hasUnsavedWork : await authoring.flush()),
			retry: () => {
				if (!runtime.paused) void authoring.retry();
			},
			suspend: () => {},
			resume: () => {},
			freeze: () => {},
			discard: () => authoring.discard(),
			restartTransport: () => authoring.restartTransport()
		})
	);
	onDestroy(() => authoring.discard());
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
				!previewChanges.some((change) => sameSourceTarget(range, change.range))
		)
	);
	/** Restore the captured annotation only when an action actually closes the editor. */
	async function runEditorAction(
		action: () => AuthoringOutcome | Promise<AuthoringOutcome>,
		restoreFocus = true
	) {
		const restore = restoreFocus ? viewer.captureAnnotationFocus?.() : undefined;
		if ((await action()) !== 'closed' || authoring.entry) return;
		await tick();
		if (!authoring.entry) restore?.();
	}
	function cancel() {
		void runEditorAction(() => authoring.cancel());
	}
	function dismiss(restoreFocus = false) {
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
	onMount(() => {
		const warn = (event: BeforeUnloadEvent) => {
			if (session.closing) return;
			if (!authoring.hasUnsavedWork) return;
			event.preventDefault();
			event.returnValue = '';
		};
		window.addEventListener('beforeunload', warn);
		return () => {
			window.removeEventListener('beforeunload', warn);
		};
	});
</script>

<BoxDismissal owner={interactionOwner} active={available && Boolean(entry)} onDismiss={dismiss} />

<div hidden={!available} inert={!available} aria-hidden={!available}>
	{#if available}
		<WorkspaceChrome {feedback} helpVariant="admin" helpReady={viewer.prepared} />
	{/if}
	{#if source.renderSource || !source.issue}
		<InteractionInputScope capture={recordContractInput}>
			<main
				oninputcapture={recordContractInput}
				onclickcapture={recordContractInput}
				class="admin-selection-enabled"
				aria-label="Contract authoring"
			>
				<h1 class="px-2 text-center text-[13px] text-ink-muted">
					Edit the instructions reps will see
				</h1>
				{#snippet panelContent()}
					{#if source.renderSource && entry}
						<PlaybookEditor
							controller={authoring}
							animateContent={animateEditorContent}
							onCancel={cancel}
							onPrimary={() => runEditorAction(() => authoring.primary())}
							onRetry={() => runEditorAction(() => authoring.retry())}
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
					prepare={!runtime.paused}
					interactive={available}
					hasPanel={Boolean(entry)}
					followScroll={authoring.locationPicking}
					{panelContent}
					selectedAnnotationId={authoring.selectedAnnotationId}
					selectedRanges={authoringHighlightRanges}
					{previewChanges}
					selectedConcessions={{}}
					onRemoveConcession={() => authoring.clearPreview()}
					panelTarget={draft?.trigger.range}
					picking={authoring.locationPicking}
					allowPlaybookNavigation={true}
					onSelect={(itemId, triggerId) => authoring.requestItemSwitch(itemId, triggerId)}
					onDocumentBackground={() => dismiss(false)}
				/>
			</main>
		</InteractionInputScope>
		{#if available && viewer.ready && viewer.displayedSnapshot}<SourceSelectionToolbar
				container={viewer.documentStageElement}
				snapshot={viewer.displayedSnapshot}
				enabled={authoring.textSelectionEnabled}
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

<style>
	main {
		--document-padding-top: calc(var(--spacing) * 2);
		--document-padding-bottom: calc(var(--spacing) * 12);
		--heading-line-height: calc(var(--spacing) * 6);
		--heading-margin-bottom: calc(var(--spacing) * 2);
		--heading-block-height: var(--mobile-utility-rail-height);
		--workspace-loading-inset: calc(
			var(--document-padding-top) + var(--document-padding-bottom) + var(--heading-block-height) +
				var(--heading-margin-bottom)
		);
		padding-block: var(--document-padding-top) var(--document-padding-bottom);
	}

	h1 {
		display: grid;
		min-height: var(--heading-block-height);
		place-items: center;
		line-height: var(--heading-line-height);
		margin-bottom: var(--heading-margin-bottom);
	}

	@media (min-width: 1000px) {
		main {
			--document-padding-top: calc(var(--spacing) * 6);
			--heading-margin-bottom: calc(var(--spacing) * 5);
			--heading-block-height: var(--heading-line-height);
		}

		h1 {
			display: block;
			min-height: 0;
		}
	}
</style>
