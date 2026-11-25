<script lang="ts">
	import { useWorkspacePresentation } from '$lib/auth/workspace-presentation.svelte';
	import { getWorkspaceRuntime } from '$lib/auth/workspace-context.svelte';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { untrack, onDestroy } from 'svelte';
	import { creationPhase } from '$lib/contract/creation-perf';
	import { goto } from '$app/navigation';
	import { getDocumentNavigation } from '$lib/document/runtime/navigation.svelte';
	import { getDocumentResources } from '$lib/document/runtime/resources.svelte';
	import { page } from '$app/state';
	import type { Id } from '../../../convex/_generated/dataModel';
	import { BuyerLinkBarVisit } from '$lib/buyer/bar-visit.svelte';
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
	let helpOpening = $state.raw<{
		token: symbol;
		destination: string;
		identity: string;
		help: HelpSession;
	}>();
	let buyerLinkVisit = $state.raw<{
		destination: string;
		identity: string;
		visit: BuyerLinkBarVisit;
	}>();
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
			if (buyerLinkVisit?.destination !== destination || buyerLinkVisit?.identity !== identity)
				buyerLinkVisit = destination
					? {
							destination,
							identity,
							visit: new BuyerLinkBarVisit(
								destination as Id<'savedContracts'>,
								accountViewer().membership.id
							)
						}
					: undefined;
			if (helpOpening?.destination === destination && helpOpening?.identity === identity) return;
			helpOpening?.help.destroy();
			helpOpening = destination
				? { token: Symbol('saved-presentation'), destination, identity, help: new HelpSession() }
				: undefined;
			if (helpOpening)
				recordDocumentLoadingMilestone('help-opening-start', {
					opening: helpOpening.help.loadingOpening
				});
		});
	});
	const currentBuyerLinkVisit = $derived(
		data.kind === 'saved' &&
			buyerLinkVisit?.destination === data.id &&
			buyerLinkVisit.identity === helpIdentity
			? buyerLinkVisit.visit
			: undefined
	);
	$effect(() => {
		const opening = helpOpening;
		const account = accountViewer();
		const generation = session.transportGeneration;
		const hidden = account.helpPreferences?.contract;
		const active = !runtime.paused;
		if (!opening) return;
		untrack(() => {
			opening.help.setActive(active);
			opening.help.configure(
				hidden === undefined
					? { kind: 'pending' }
					: {
							kind: 'preference',
							variant: 'contract',
							identity: opening.identity,
							hidden,
							save: (hidden) =>
								client.mutation(api.profiles.setHelpHidden, { variant: 'contract', hidden }),
							current: () =>
								helpOpening === opening &&
								data.kind === 'saved' &&
								data.id === opening.destination &&
								!runtime.paused &&
								helpIdentity === opening.identity &&
								session.transportGeneration === generation &&
								!session.closing
						}
			);
			opening.help.considerAutomatic();
		});
	});
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
	// The route owns both leases, independently of lazy modules, rendering and retries.
	function ownSaved(id: string) {
		if (owner?.id === id) return owner;
		let releaseResource = resources?.beginOpen(id);
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

{#if data.kind === 'saved' && !creating && !runtime.paused && helpOpening?.help.open}
	<HelpModal
		help={helpOpening.help}
		isAdmin={accountViewer().membership.role === 'admin'}
		onClose={() => helpOpening?.help.close()}
	/>
{/if}
<div inert={creating} aria-hidden={creating}>
	<WorkspaceRouteFrame
		kind="saved"
		help={helpOpening?.help ?? creationHelp}
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
								buyerLinkVisit={currentBuyerLinkVisit}
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
