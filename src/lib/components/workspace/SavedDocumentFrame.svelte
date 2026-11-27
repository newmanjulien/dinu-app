<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import type { Id } from '../../../convex/_generated/dataModel';
	import type { ContractEditor } from '$lib/contract/editors.svelte';
	import type { OperationStatus } from '$lib/components/chrome/operation-status';
	import {
		getDocumentResources,
		type ViewerBindings
	} from '$lib/document/runtime/resources.svelte';
	import { getDocumentSection } from '$lib/document/runtime/section.svelte';
	import { createDocumentWorkspace } from '$lib/document/runtime/workspace-factory';
	import {
		setDocumentWorkspace,
		type DocumentWorkspace
	} from '$lib/document/runtime/workspace-context';
	import { setInteractionOwner } from '$lib/components/ui/interactions';
	import { getWorkspaceRuntime } from '$lib/auth/workspace-context.svelte';
	import { useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { recordDocumentInput } from '$lib/document/runtime/render-perf';
	import { sameSelection } from '$lib/playbook/model';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import InteractionInputScope from '$lib/components/ui/InteractionInputScope.svelte';
	import DocumentViewerSlot from '$lib/components/document/DocumentViewerSlot.svelte';
	import DocumentSkeleton from '$lib/components/document/DocumentSkeleton.svelte';
	import BuyerLinkBar from '$lib/buyer/BuyerLinkBar.svelte';
	import Button from '$lib/ui/Button.svelte';
	import WorkspaceDocumentFeedback from './WorkspaceDocumentFeedback.svelte';
	import RepWorkspace from './RepWorkspace.svelte';
	import type { SavedRouteFrameState } from './saved-route-frame';

	let {
		editor,
		mode = 'negotiate',
		onModeChange,
		interactionAdmitted = true,
		openingRevision,
		onVisible,
		onFailure,
		onRetry,
		onFrame
	}: {
		editor: ContractEditor;
		mode?: 'negotiate' | 'comments';
		onModeChange?: (mode: 'negotiate' | 'comments') => void;
		interactionAdmitted?: boolean;
		openingRevision?: unknown;
		onVisible?: () => void;
		onFailure?: () => void;
		onRetry: () => void;
		onFrame?: (frame: SavedRouteFrameState) => () => void;
	} = $props();

	const runtime = getWorkspaceRuntime();
	const session = useViewerSession();
	const section = getDocumentSection();
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
	const { source, viewer } = workspace;
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
	let commentsFrame = $state.raw<{ workspace: DocumentWorkspace; interactionOwner: symbol }>();

	const commentsActive = $derived(mode === 'comments' && Boolean(editor.buyerLink));
	const activeWorkspace = $derived(commentsActive ? commentsFrame?.workspace : workspace);
	const activeInteractionOwner = $derived(
		commentsActive ? commentsFrame?.interactionOwner : interactionOwner
	);

	let lastMode: 'negotiate' | 'comments' = 'negotiate';
	const scrollTopByMode = { negotiate: 0, comments: 0 };
	$effect.pre(() => {
		const nextMode: 'negotiate' | 'comments' = commentsActive ? 'comments' : 'negotiate';
		if (nextMode === lastMode) return;
		const previousMode = lastMode;
		lastMode = nextMode;
		const viewport = section?.viewport;
		if (!viewport) return;
		scrollTopByMode[previousMode] = viewport.scrollTop;
		const targetTop = scrollTopByMode[nextMode];
		let cancelled = false;
		void tick().then(() => {
			if (!cancelled && viewport.isConnected) viewport.scrollTop = targetTop;
		});
		return () => {
			cancelled = true;
		};
	});

	$effect(() =>
		onFrame?.({
			id: editor.id,
			workspace: activeWorkspace,
			interactionOwner: activeInteractionOwner,
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

	let firstPagesSeen = $state(false);
	$effect(() => {
		const ready = viewer.firstPagesReady;
		if (ready && source.renderSource && ready.source === source.renderSource) firstPagesSeen = true;
	});

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

	type CommentsViewComponent = typeof import('./ContractCommentsView.svelte').default;
	let CommentsView = $state.raw<CommentsViewComponent>();
	let commentsOpened = $state(false);
	let commentsLoading: Promise<void> | undefined;
	let commentsFailed = $state(false);
	function loadCommentsView() {
		if (CommentsView || commentsLoading) return;
		commentsFailed = false;
		commentsLoading = import('./ContractCommentsView.svelte')
			.then((mod) => {
				CommentsView = mod.default;
			})
			.catch(() => {
				commentsFailed = true;
			})
			.finally(() => {
				commentsLoading = undefined;
			});
	}
	$effect(() => {
		if (!editor.buyerLink) {
			commentsOpened = false;
			return;
		}
		if (commentsActive) {
			commentsOpened = true;
			loadCommentsView();
		}
	});

	const showBuyerLinkBar = $derived(
		interactionAdmitted &&
			!runtime.paused &&
			firstPagesSeen &&
			Boolean(editor.persistence) &&
			!editor.persistence?.deleted &&
			(!editor.persistence?.workBlock || Boolean(editor.buyerLink))
	);
	const hasPendingChangesForBuyer = $derived(
		Boolean(editor.buyerLink && !sameSelection(editor.renderChoices, editor.buyerLink.concessions))
	);
</script>

{#snippet emptyPanel()}{/snippet}
{#if editor.persistence}
	<RepWorkspace
		{editor}
		active={!commentsActive}
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
	<WorkspaceDocumentFeedback workspace={activeWorkspace} feedback={chrome?.feedback ?? null} />
{/if}
<InteractionInputScope
	capture={(event) => {
		if (event.type === 'click') recordDocumentInput(event);
	}}
>
	<main
		class="[--document-section-bottom-padding:calc(64px+var(--buyer-link-bar-height,0px))] [--workspace-loading-inset:calc(var(--spacing)*30)] min-[1000px]:[--workspace-loading-inset:calc(var(--spacing)*22)]"
		onclickcapture={recordDocumentInput}
		aria-label="Contract document"
	>
		{#if commentsOpened && editor.buyerLink && CommentsView}
			<div
				class={!commentsActive
					? 'pointer-events-none invisible fixed top-0 left-[-100000px] w-full [contain:layout_paint]'
					: ''}
				inert={!commentsActive}
				aria-hidden={!commentsActive}
			>
				<CommentsView
					{editor}
					buyerLink={editor.buyerLink}
					active={commentsActive && !runtime.paused}
					paused={runtime.paused}
					{interactionAdmitted}
					hasPendingChanges={hasPendingChangesForBuyer}
					onFrame={(next) => {
						commentsFrame = next;
						return () => {
							if (commentsFrame === next) commentsFrame = undefined;
						};
					}}
				/>
			</div>
		{/if}
		{#if commentsActive && editor.buyerLink}
			{#if !CommentsView}
				{#if commentsFailed}
					<div role="alert" class="p-8 text-center text-sm">
						<p>We couldn’t load the comments view.</p>
						<Button variant="secondary" class="mt-4" onclick={loadCommentsView}>Try again</Button>
					</div>
				{:else}
					<DocumentSkeleton label="Loading comments" />
				{/if}
			{/if}
		{:else}
			<DocumentViewerSlot
				{attachment}
				entry={resource}
				reserveReviewGutter
				panelContent={emptyPanel}
				selectedConcessions={editor.renderChoices}
				onSelect={() => false}
				{...bindings}
				reviewTags={interactionAdmitted ? bindings?.reviewTags : []}
				active={!runtime.paused}
				foreground={interactionAdmitted}
				prepare={!runtime.paused && editor.definitionsReady}
				interactive={interactionAdmitted && !session.blocked && editor.definitionsReady}
				annotationsVisible={interactionAdmitted}
				onPresentation={(outcome) => {
					presentation = outcome;
					bindings?.onPresentation?.(outcome);
				}}
			/>
		{/if}
	</main>
</InteractionInputScope>

{#if showBuyerLinkBar}
	<BuyerLinkBar
		id={editor.id as Id<'savedContracts'>}
		buyerLink={editor.buyerLink}
		hasUnreadComment={editor.hasUnreadComment}
		{mode}
		{onModeChange}
		onPreloadComments={loadCommentsView}
		disabled={Boolean(editor.persistence?.workBlock)}
	/>
{/if}
