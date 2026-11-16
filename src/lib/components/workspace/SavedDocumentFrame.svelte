<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import type { ContractEditor } from '$lib/contract/editors.svelte';
	import type { BuyerLinkBarVisit } from '$lib/buyer/bar-visit.svelte';
	import type { useReadQuery } from '$lib/auth/read-query.svelte';
	import type { api } from '../../../convex/_generated/api';
	import type { OperationStatus } from '$lib/components/chrome/operation-status';
	import {
		getDocumentResources,
		type ViewerBindings
	} from '$lib/document/runtime/resources.svelte';
	import { createDocumentWorkspace } from '$lib/document/runtime/workspace-factory';
	import { setDocumentWorkspace } from '$lib/document/runtime/workspace-context';
	import { setInteractionOwner } from '$lib/components/ui/interactions';
	import { getWorkspaceRuntime } from '$lib/auth/workspace-context.svelte';
	import { useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { recordDocumentInput } from '$lib/document/runtime/render-perf';
	import { sameSelection } from '$lib/playbook/model';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import InteractionInputScope from '$lib/components/ui/InteractionInputScope.svelte';
	import DocumentViewerSlot from '$lib/components/document/DocumentViewerSlot.svelte';
	import WorkspaceDocumentFeedback from './WorkspaceDocumentFeedback.svelte';
	import RepWorkspace from './RepWorkspace.svelte';
	import type { SavedRouteFrameState } from './saved-route-frame';
	let {
		editor,
		buyerLinkVisit,
		latestBuyerLink,
		interactionAdmitted = true,
		openingRevision,
		onVisible,
		onFailure,
		onRetry,
		onFrame
	}: {
		editor: ContractEditor;
		buyerLinkVisit?: BuyerLinkBarVisit;
		latestBuyerLink: ReturnType<typeof useReadQuery<typeof api.buyerLinks.latest>>;
		interactionAdmitted?: boolean;
		openingRevision?: unknown;
		onVisible?: () => void;
		onFailure?: () => void;
		onRetry: () => void;
		onFrame?: (frame: SavedRouteFrameState) => () => void;
	} = $props();
	const runtime = getWorkspaceRuntime();
	const session = useViewerSession();
	const resources = getDocumentResources();
	const resource = resources
		? untrack(() => resources.acquireContract(editor.readable!, editor.documentInput))
		: undefined;
	const attachment =
		resource && resources
			? untrack(() => resources.activate(resource, editor.renderChoices))
			: undefined;
	const workspace = setDocumentWorkspace(
		resource?.workspace ?? untrack(() => createDocumentWorkspace(editor.documentInput))
	);
	const interactionOwner = setInteractionOwner(resource?.owner ?? Symbol('saved-document'));
	const { source, viewer, renderer } = workspace;
	onDestroy(() => {
		attachment?.release();
	});
	let bindings = $state.raw<ViewerBindings>();
	let chrome = $state.raw<{
		feedback: OperationStatus | null;
		onDownload?: () => void;
		downloadReason: string | null;
	}>();
	let presentation = $state<'pending' | 'success' | 'error'>('pending');
	$effect(() =>
		onFrame?.({
			id: editor.id,
			workspace,
			interactionOwner,
			get onDownload() {
				return chrome?.onDownload;
			},
			get downloadReason() {
				return chrome?.downloadReason;
			}
		})
	);
	$effect(() => workspace.accept(editor.documentInput));
	$effect(() => attachment?.update(editor.renderChoices));
	const exactReadable = $derived(
		Boolean(
			viewer.exactDisplay &&
			source.renderSource &&
			viewer.exactDisplay.source === source.renderSource &&
			!viewer.exactDisplay.previewChanges.length &&
			sameSelection(viewer.exactDisplay.concessions, editor.renderChoices)
		)
	);
	let notified: unknown;
	$effect(() => {
		if (!editor.persistence && exactReadable && notified !== openingRevision) {
			notified = openingRevision;
			untrack(() => onVisible?.());
		}
	});
</script>

{#snippet emptyPanel()}{/snippet}
{#if editor.persistence}
	<RepWorkspace
		{editor}
		{buyerLinkVisit}
		{latestBuyerLink}
		{interactionAdmitted}
		{openingRevision}
		{onVisible}
		{onFailure}
		{onRetry}
		onBindings={(value) => {
			bindings = value;
		}}
		onChrome={(value) => {
			chrome = value;
		}}
	/>
{:else}
	<WorkspacePresentationReporter
		active={interactionAdmitted && !runtime.paused}
		outcome={presentation}
		revision={openingRevision}
	/>
{/if}
{#if interactionAdmitted && !runtime.paused}
	<WorkspaceDocumentFeedback {workspace} feedback={chrome?.feedback ?? null} />
{/if}
<InteractionInputScope
	capture={(event) => {
		if (event.type === 'click') recordDocumentInput(event);
	}}
>
	<main
		class="pb-[calc(64px+var(--buyer-link-bar-height,0px))] [--workspace-loading-inset:calc(var(--spacing)*30)] min-[1000px]:[--workspace-loading-inset:calc(var(--spacing)*22)]"
		onclickcapture={recordDocumentInput}
		aria-label="Contract document"
	>
		<DocumentViewerSlot
			{attachment}
			entry={resource}
			layout="contract"
			panelContent={emptyPanel}
			selectedConcessions={editor.renderChoices}
			onRemoveConcession={() => {}}
			onSelect={() => false}
			{...bindings}
			reviewTags={interactionAdmitted ? bindings?.reviewTags : []}
			reviewGutter={interactionAdmitted ? bindings?.reviewGutter : 0}
			active={!runtime.paused}
			prepare={!runtime.paused && editor.definitionsReady}
			interactive={interactionAdmitted && !session.blocked && editor.definitionsReady}
			annotationsVisible={interactionAdmitted}
			onPresentation={(outcome) => {
				presentation = outcome;
				bindings?.onPresentation?.(outcome);
			}}
		/>
	</main>
</InteractionInputScope>
