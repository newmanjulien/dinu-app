<script lang="ts">
	import { useUiPreferences, optimisticHelp } from '$lib/auth/ui-preferences.svelte';
	const uiPreferences = useUiPreferences();
	import { useWorkspacePresentation } from '$lib/auth/workspace-presentation.svelte';
	import { getWorkspaceRuntime } from '$lib/auth/workspace-context.svelte';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { untrack, onDestroy } from 'svelte';
	import { creationPhase } from '$lib/contract/creation-perf';
	import { goto } from '$app/navigation';
	import { getDocumentNavigation } from '$lib/document/runtime/navigation.svelte';
	import { getDocumentResources } from '$lib/document/runtime/resources.svelte';
	import { page } from '$app/state';
	import { getPageMetadata } from '$lib/auth/page-metadata.svelte';
	import type { Id } from '../../../convex/_generated/dataModel';
	import type { ContractDestination } from '$lib/contract/saved';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { useConvexClient } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import { HelpSession } from '$lib/components/ui/modal/help-session.svelte';
	import HelpModal from '$lib/components/ui/modal/HelpModal.svelte';
	import { loadDocumentSearch } from '$lib/components/document/document-tools';
	import { loadComponent } from '$lib/auth/component-loader.svelte';
	import { loadSavedContract } from '$lib/auth/destination-code';
	import { afterPaint } from '$lib/document/runtime/scheduler';
	import { recordDocumentLoadingMilestone } from '$lib/document/runtime/render-perf';
	import DocumentSkeleton from '$lib/components/document/DocumentSkeleton.svelte';
	import LoadingState from '$lib/ui/LoadingState.svelte';
	import NewContract from './NewContract.svelte';
	import WorkspaceRouteFrame from './WorkspaceRouteFrame.svelte';
	import type { SavedRouteFrameState } from './saved-route-frame';
	import { getContractEditors } from '$lib/contract/editors.svelte';
	const documentNavigation = getDocumentNavigation();
	const resources = getDocumentResources();
	const presentation = useWorkspacePresentation();
	const runtime = getWorkspaceRuntime();
	const session = useViewerSession();
	const editors = getContractEditors();
	const pageMetadata = getPageMetadata();
	const accountViewer = useViewer();
	const client = useConvexClient();
	const creationHelp = new HelpSession();
	let { data }: { data: ContractDestination } = $props();
	let creating = $state(untrack(() => data.kind === 'new'));
	let creationTarget = $state<string | null>(null);
	let creationNavigated = $state(false);
	let savedOpeningFailed = $state(false);
	let completeOpening: ((ready: boolean) => void) | undefined;
	function settleOpening(ready: boolean) {
		const complete = completeOpening;
		completeOpening = undefined;
		complete?.(ready);
	}
	const creationHandoff = $derived(data.kind === 'saved' && data.id === creationTarget);
	let savedRequested = $state(false);
	const preview = loadComponent(
		() => import('./CreationContractPreview.svelte'),
		() => creating,
		() => session.transportGeneration
	);
	const CreationPreview = $derived(preview.component);
	let previewRenderFailed = $state(false);
	let previewAttempt = $state(0);
	let frame = $state.raw<SavedRouteFrameState>();
	const activeFrame = $derived(data.kind === 'saved' && frame?.id === data.id ? frame : undefined);
	let contractMode = $state<'negotiate' | 'comments'>('negotiate');
	let helpOpening = $state.raw<{
		token: symbol;
		destination: string;
		identity: string;
		help: HelpSession;
	}>();
	let commentsHelp = $state.raw<HelpSession>();
	const helpIdentity = $derived.by(() => {
		const account = accountViewer();
		return JSON.stringify([
			session.preparedSessionId,
			session.userId,
			account.profile.id,
			account.membership.id,
			account.company.id
		]);
	});
	// Destination identity deliberately excludes transport/module/render retry generations.
	$effect(() => {
		const destination = data.kind === 'saved' ? data.id : undefined;
		const identity = helpIdentity;
		untrack(() => {
			if (helpOpening?.destination === destination && helpOpening?.identity === identity) return;
			contractMode = 'negotiate';
			helpOpening?.help.destroy();
			commentsHelp?.destroy();
			commentsHelp = undefined;
			helpOpening = destination
				? {
						token: Symbol('saved-presentation'),
						destination,
						identity,
						help: new HelpSession()
					}
				: undefined;
			if (helpOpening)
				recordDocumentLoadingMilestone('help-opening-start', {
					opening: helpOpening.help.loadingOpening
				});
		});
	});
	$effect(() => {
		if (data.kind !== 'saved' || owner?.editor.buyerLink === null) contractMode = 'negotiate';
	});
	$effect(() => {
		const opening = helpOpening;
		const account = accountViewer();
		const generation = session.transportGeneration;
		const contractHidden = uiPreferences.data?.helpPreferences.contract;
		const commentsHidden = uiPreferences.data?.helpPreferences.buyerLink;
		const mode = contractMode;
		const active = !runtime.paused;
		if (!opening) return;
		untrack(() => {
			const isCurrent = () =>
				helpOpening === opening &&
				data.kind === 'saved' &&
				data.id === opening.destination &&
				!runtime.paused &&
				helpIdentity === opening.identity &&
				session.transportGeneration === generation &&
				!session.closing;
			opening.help.setActive(active && mode === 'negotiate');
			opening.help.configure(
				contractHidden === undefined
					? { kind: 'pending' }
					: {
							kind: 'preference',
							variant: 'contract',
							identity: opening.identity,
							hidden: contractHidden,
							save: (hidden) =>
								client.mutation(
									api.profiles.setHelpHidden,
									{ variant: 'contract', hidden },
									{ optimisticUpdate: (store) => optimisticHelp(store, 'contract', hidden) }
								),
							current: isCurrent
						}
			);
			if (mode === 'negotiate') opening.help.considerAutomatic();

			if (mode === 'comments') {
				const current = (commentsHelp ??= new HelpSession());
				current.setActive(active);
				current.configure(
					commentsHidden === undefined
						? { kind: 'pending' }
						: {
								kind: 'preference',
								variant: 'contract-comments',
								identity: opening.identity,
								hidden: commentsHidden,
								save: (hidden) =>
									client.mutation(
										api.profiles.setHelpHidden,
										{ variant: 'buyerLink', hidden },
										{ optimisticUpdate: (store) => optimisticHelp(store, 'buyerLink', hidden) }
									),
								current: isCurrent
							}
				);
				current.considerAutomatic();
			} else {
				commentsHelp?.setActive(false);
			}
		});
	});
	const activeHelp = $derived(
		contractMode === 'comments' ? (commentsHelp ?? helpOpening?.help) : helpOpening?.help
	);
	let helpPresentedToken = $state<symbol>();
	const helpPresented = $derived(Boolean(helpOpening && helpPresentedToken === helpOpening.token));
	$effect(() => {
		const opening = helpOpening;
		if (!opening?.help.admitted || helpPresentedToken === opening.token) return;
		const prepared =
			data.kind === 'saved' &&
			owner?.id === data.id &&
			Boolean(owner.editor.readable) &&
			Boolean(resources?.isPreparedContract(data.id, owner.editor.renderChoices));
		if (!opening.help.open || prepared) {
			helpPresentedToken = opening.token;
			recordDocumentLoadingMilestone('help-document-admitted', {
				opening: opening.help.loadingOpening
			});
			return;
		}
		// Show automatic Help before constructing the first contract pages.
		const lifetime = new AbortController();
		void afterPaint(lifetime.signal)
			.then(() => {
				if (helpOpening === opening && opening.help.admitted) {
					helpPresentedToken = opening.token;
					recordDocumentLoadingMilestone('help-document-admitted', {
						opening: opening.help.loadingOpening
					});
				}
			})
			.catch(() => {});
		return () => lifetime.abort();
	});
	// Download search alongside the saved module, policy and document; mounting still requires a workspace.
	$effect(() => {
		if (data.kind === 'saved' || savedRequested) void loadDocumentSearch().catch(() => {});
	});
	let owner = $state.raw<{
		id: string;
		editor: ReturnType<typeof editors.acquire>['editor'];
		release: () => void;
		protect: () => void;
	}>();
	const bootstrapGeneration = untrack(() => session.transportGeneration);
	let bootstrapConsumed = false;
	// The route owns both leases, independently of lazy modules, rendering and retries.
	function ownSaved(id: string) {
		if (owner?.id === id) return owner;
		let releaseResource = resources?.beginOpen(id);
		if (!bootstrapConsumed) {
			bootstrapConsumed = true;
			const bootstrap = page.data.routeBootstrap;
			if (
				bootstrap?.kind === 'current' &&
				bootstrap.state?._id === id &&
				session.transportGeneration === bootstrapGeneration &&
				bootstrap.sessionId === session.preparedSessionId &&
				bootstrap.userId === session.userId
			)
				editors.seedAuthoritative(bootstrap.state);
		}
		const opening = editors.acquire(id);
		const previous = owner;
		owner = {
			id,
			editor: opening.editor,
			protect: () => {
				if (resources && !resources.hasOpening(id)) {
					releaseResource?.();
					releaseResource = resources.beginOpen(id);
				}
			},
			release: () => {
				if (opening.editor.pending) void opening.editor.savePending();
				opening.release();
				releaseResource?.();
			}
		};
		previous?.release();
		return owner;
	}
	function prepareSavedEditor(id: Id<'savedContracts'>) {
		const current = ownSaved(id);
		if (current.editor.error || current.editor.viewError) editors.retry(id);
	}
	$effect(() => {
		const next = data;
		untrack(() => {
			if (next.kind === 'saved') {
				ownSaved(next.id);
				if (next.id !== creationTarget) {
					settleOpening(false);
					creating = false;
					creationTarget = null;
					creationNavigated = false;
					savedOpeningFailed = false;
				}
			} else if (!creating) {
				settleOpening(false);
				owner?.release();
				owner = undefined;
				creating = true;
				savedRequested = false;
				creationTarget = null;
				creationNavigated = false;
				savedOpeningFailed = false;
				previewRenderFailed = false;
			}
		});
	});
	// The editor and tab title share the same authorized contracts.state read.
	let titleRead = $state.raw<{
		id: string;
		read: ReturnType<typeof editors.retainMetadata>['read'];
	}>();
	$effect(() => {
		const id =
			data.kind === 'saved' && !runtime.paused && editors.accessAvailable ? data.id : undefined;
		if (!id) return;
		const lease = editors.retainMetadata(id);
		titleRead = { id, read: lease.read };
		return () => {
			titleRead = undefined;
			lease.release();
		};
	});
	$effect(() => {
		if (data.kind !== 'saved' || titleRead?.id !== data.id || !titleRead.read.current) return;
		const title =
			titleRead.read.data === null
				? 'Contract not found'
				: titleRead.read.data
					? titleRead.read.buyerName
						? `Negotiate with ${titleRead.read.buyerName}`
						: 'Negotiate a contract'
					: undefined;
		if (title) return pageMetadata.register(title, page.route.id, page.url.pathname);
	});
	$effect(() => {
		const current = owner;
		const readable = current?.editor.readable;
		const input = current?.editor.documentInput;
		const choices = current?.editor.renderChoices;
		const removed = current?.editor.isDeleted || current?.editor.metadata === null;
		if (removed) {
			untrack(() => {
				resources?.remove(current!.id);
			});
		} else if (readable && input) {
			// Only the shared editor's validated approved input can start saved preparation.
			untrack(() => {
				current!.protect();
				resources?.prepare(readable, input, choices);
			});
		}
	});
	const saved = loadComponent(
		loadSavedContract,
		() => data.kind === 'saved' || savedRequested,
		() => session.transportGeneration
	);
	const SavedContract = $derived(saved.component);
	function finishCreation(ready: boolean) {
		// Keep the target until this route changes so Help admission cannot remount the saved viewer.
		creating = false;
		settleOpening(ready);
	}
	// A confirmed navigation can finish its first pages or expose the saved route's retry UI.
	$effect(() => {
		if (!creating || !creationHandoff || !creationNavigated) return;
		if (saved.failed || savedOpeningFailed) {
			finishCreation(false);
			return;
		}
		const workspace = activeFrame?.workspace;
		const ready = workspace?.viewer.firstPagesReady;
		if (!ready?.pages.length || ready.source !== workspace?.source.renderSource) return;
		finishCreation(true);
	});
	function prepareSaved() {
		savedRequested = true;
		if (saved.failed) saved.retry();
	}
	let active = true;
	onDestroy(() => {
		active = false;
		settleOpening(false);
		owner?.release();
		helpOpening?.help.destroy();
		commentsHelp?.destroy();
		creationHelp.destroy();
	});
	async function openSaved(id: Id<'savedContracts'>) {
		if (!active) return false;
		settleOpening(false);
		ownSaved(id);
		if (creationTarget !== id) savedOpeningFailed = false;
		creationTarget = id;
		creationNavigated = false;
		const releaseView = documentNavigation?.preserve(new URL(`/contracts/${id}`, page.url).href);
		try {
			if (data.kind !== 'saved' || data.id !== id)
				await goto(`/contracts/${id}`, { replaceState: true, noScroll: true, keepFocus: true });
			if (!active || data.kind !== 'saved' || data.id !== id) return false;
			creationPhase('navigation-end');
			creationNavigated = true;
			return await new Promise<boolean>((resolve) => {
				completeOpening = resolve;
			});
		} catch {
			return false;
		} finally {
			releaseView?.();
		}
	}
</script>

{#if data.kind === 'saved' && !creating && !runtime.paused && activeHelp?.open}
	<HelpModal
		help={activeHelp}
		isAdmin={accountViewer().membership.role === 'admin'}
		onClose={() => activeHelp.close()}
	/>
{/if}
<div inert={creating} aria-hidden={creating}>
	<WorkspaceRouteFrame
		kind="saved"
		{contractMode}
		help={activeHelp ?? creationHelp}
		helpHosted
		active={!runtime.paused && (creating || Boolean(helpOpening?.help.admitted))}
		workspace={activeFrame?.workspace}
		interactionOwner={activeFrame?.interactionOwner}
		settingsHref={data.kind === 'saved' && !creating ? `/contracts/${data.id}/settings` : undefined}
		onDownload={activeFrame?.onDownload}
		downloadReason={activeFrame?.downloadReason}
	>
		<div class="relative">
			{#if creating && CreationPreview}{#key previewAttempt}<CreationPreview
						freeze={savedRequested}
						onFailure={(failed) => (previewRenderFailed = failed)}
					/>{/key}{/if}
			{#if data.kind === 'saved'}
				<!-- The saved viewer needs full width to lay out pages while the preview remains in flow. -->
				<div class={creating ? 'invisible absolute inset-x-0 top-0' : ''} aria-hidden={creating}>
					{#if !creating && !helpPresented && !creationHandoff}
						<WorkspacePresentationReporter outcome="pending" />
						<DocumentSkeleton reserveReviewGutter label="Loading contract" />
					{:else if SavedContract}{#key data.id}
							<SavedContract
								id={data.id}
								mode={contractMode}
								onModeChange={(next) => (contractMode = next)}
								interactionAdmitted={!creating}
								onVisible={() => creationPhase('displayed')}
								onFailure={() => {
									if (creating && creationHandoff) savedOpeningFailed = true;
								}}
								onFrame={(next) => {
									frame = next;
									return () => {
										if (frame === next) frame = undefined;
									};
								}}
							/>
						{/key}
					{:else if saved.failed}
						<WorkspacePresentationReporter outcome="error" />
						<LoadingState layout="workspace">
							<p role="alert" class="text-sm">We couldn’t load the contract viewer.</p>
							<button
								class="text-sm underline"
								onclick={() => {
									presentation?.restart();
									saved.retry();
								}}>Try again</button
							>
						</LoadingState>
					{:else}<WorkspacePresentationReporter outcome="pending" /><DocumentSkeleton
							reserveReviewGutter
							label="Loading contract"
						/>{/if}
				</div>
			{/if}
		</div>
	</WorkspaceRouteFrame>
</div>
{#if creating}<NewContract
		onOpen={openSaved}
		onCreate={prepareSaved}
		onPrepareSaved={prepareSavedEditor}
		previewFailed={preview.failed || previewRenderFailed}
		onRetryPreview={() => {
			if (preview.failed) preview.retry();
			if (previewRenderFailed) {
				previewRenderFailed = false;
				previewAttempt++;
			}
		}}
	/>{/if}
