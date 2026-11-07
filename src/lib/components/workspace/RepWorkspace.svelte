<script lang="ts">
	import { ConvexError } from 'convex/values';
	import { errorCode, workBlockMessage } from '$lib/contract/work-policy';
	import HubSpotRelink from './HubSpotRelink.svelte';
	import { journalDownload, flushDownloadAcks } from '$lib/contract/download-journal';
	let repairHubSpot = $state(false);
	let exportIdentity: { operationId: string; revision: number } | null = null;
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { ContractReviewController } from '$lib/contract/review-controller.svelte';
	import { documentAnnotations } from '$lib/playbook/document-overlay';
	import { onDestroy, onMount, untrack } from 'svelte';
	import { navigating, page } from '$app/state';
	import { useAuth, useConvexClient, useQuery } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import type { Id } from '../../../convex/_generated/dataModel';
	import type { TemplateContent } from '$lib/contract/saved';
	import type { ContractEditor } from '$lib/contract/editors.svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { getContractOpenings } from '$lib/contract/snapshot-cache';
	import type { OperationStatus } from '$lib/components/chrome/operation-status';
	import { createContractWorkspace } from '$lib/document/runtime/workspace-factory';
	import { setContractWorkspace } from '$lib/document/runtime/workspace-context';
	import { conflictsForConcession } from '$lib/playbook/selection-conflicts';
	import { getDocumentResources } from '$lib/document/runtime/resources.svelte';
	import { getWorkspaceRuntime } from '$lib/auth/workspace-context.svelte';
	import DocumentViewerSlot from '$lib/components/document/DocumentViewerSlot.svelte';
	import { REVIEW_GUTTER_WIDTH } from '$lib/components/document/workspace-layout';
	import BoxDismissal from '$lib/components/playbook/BoxDismissal.svelte';
	import RepPlaybookPanel from '$lib/components/playbook/RepPlaybookPanel.svelte';
	import ReviewCompletedModal from '$lib/components/ui/modal/ReviewCompletedModal.svelte';
	import WorkspaceChrome from './WorkspaceChrome.svelte';
	import HeaderContent from '$lib/components/chrome/HeaderContent.svelte';
	import { recordContractInput } from '$lib/document/runtime/render-perf';
	import { setInteractionOwner } from '$lib/components/ui/interactions';
	import InteractionInputScope from '$lib/components/ui/InteractionInputScope.svelte';
	import { sameSelection } from '$lib/playbook/model';
	import { downloadWord } from '$lib/contract/export/download';
	import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
	import Button from '$lib/ui/Button.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import {
		approvalCoversPending,
		savedReviews,
		selectedReviewApplications,
		reviewStatus,
		type ReviewTag
	} from '$lib/contract/approval';
	import { saveError } from '$lib/contract/saved';
	let {
		snapshot,
		editor: contractEditor,
		interactionAdmitted = true,
		onVisible,
		onFailure
	}: {
		snapshot: TemplateContent;
		editor: ContractEditor;
		interactionAdmitted?: boolean;
		onVisible?: () => void;
		onFailure?: () => void;
	} = $props();
	const initialContract = untrack(() => contractEditor.metadata!);
	const persistence = untrack(() => contractEditor.persistence!);
	const metadata = {
		get data() {
			return contractEditor.metadata;
		},
		get error() {
			return contractEditor.error;
		}
	};
	const openings = untrack(() => getContractOpenings());
	const runtime = getWorkspaceRuntime();
	const resources = getDocumentResources();
	const resource = resources
		? untrack(() =>
				resources.acquireContract({
					id: initialContract._id,
					status: 'ready',
					snapshot,
					contract: initialContract
				})
			)
		: undefined;
	const attachment =
		resource && resources
			? untrack(() => resources.activate(resource, persistence.choices))
			: undefined;
	onDestroy(() => attachment?.release());
	const interactionOwner = setInteractionOwner(resource?.owner ?? Symbol('rep-workspace'));
	const workspace = setContractWorkspace(
		resource?.workspace ??
			untrack(() =>
				createContractWorkspace({
					blocks: { data: snapshot.blocks },
					items: { data: snapshot.items }
				})
			)
	);

	const { source, viewer } = workspace;
	const client = useConvexClient();
	const auth = useAuth();
	const session = useViewerSession();
	const accountViewer = useViewer();
	const membershipId = accountViewer().membership.id;
	const contractId = untrack(() => initialContract._id);
	let mounted = $state(false);
	const approvalQuery = useQuery(api.contractApprovals.latest, () =>
		mounted && auth.isAuthenticated && !runtime.paused ? { membershipId, id: contractId } : 'skip'
	);
	const latestApproval = $derived(approvalQuery.data);
	$effect(() => attachment?.update(persistence.choices));
	let notifiedVisible = $state(false);
	let recordedOpening = false;
	let viewerPresentation =
		$state<import('$lib/auth/workspace-presentation.svelte').PresentationOutcome>('pending');
	const displayedStateReconciled = $derived.by(() => {
		const displayed = viewer.displayedSnapshot;
		return Boolean(
			stateReconciled &&
			!persistence.recoveryPending &&
			viewer.pagesVisible &&
			viewer.layoutPrepared &&
			displayed &&
			displayed === workspace.renderer.snapshot &&
			displayed.source === source.renderSource &&
			!displayed.previewChanges.length &&
			sameSelection(displayed.concessions, persistence.choices)
		);
	});
	$effect(() => {
		if (
			displayedStateReconciled &&
			!persistence.deleted &&
			!source.issue &&
			!workspace.renderer.error &&
			!viewer.preparationBlocked &&
			!notifiedVisible
		) {
			notifiedVisible = true;
			untrack(() => onVisible?.());
		}
	});
	$effect(() => {
		if (
			displayedStateReconciled &&
			viewer.interactionEnabled &&
			!persistence.pending &&
			!persistence.deleted &&
			!workspace.renderer.error &&
			!source.issue &&
			!recordedOpening
		) {
			recordedOpening = true;
			untrack(() => {
				openings.record(contractId);
			});
		}
	});
	$effect(() => {
		if (
			!notifiedVisible &&
			(workspace.renderer.error ||
				source.issue ||
				viewer.preparationBlocked ||
				persistence.deleted ||
				metadata.error)
		)
			untrack(() => onFailure?.());
	});
	const presentationOutcome = $derived(
		persistence.deleted ||
			(!source.renderSource && source.issue) ||
			(viewerPresentation === 'error' && (workspace.renderer.error || viewer.preparationBlocked))
			? 'error'
			: viewerPresentation === 'success' &&
				  displayedStateReconciled &&
				  !source.issue &&
				  !workspace.renderer.error &&
				  !viewer.preparationBlocked
				? 'success'
				: 'pending'
	);
	let connected = $state(false);
	let active = true;
	let checkingDeal: Promise<void> | undefined;
	async function checkDeal() {
		if (!persistence.confirmed.hubspot) return;
		if (checkingDeal) return checkingDeal;
		const current = client
			.action(api.hubspotDeals.check, { membershipId, contractId })
			.then(({ outcome, generation }) => {
				if (
					active &&
					outcome === 'unavailable' &&
					generation === persistence.confirmed.hubspot?.generation
				) {
					persistence.blockWork('deal-unavailable');
					throw new ConvexError({
						code: 'deal-unavailable',
						message: workBlockMessage('deal-unavailable')
					});
				}
			})
			.finally(() => {
				if (checkingDeal === current) checkingDeal = undefined;
			});
		checkingDeal = current;
		return current;
	}
	onMount(() => {
		mounted = true;
		const observe = () => {
			if (document.visibilityState === 'visible') void checkDeal().catch(() => {});
		};
		observe();
		document.addEventListener('visibilitychange', observe);
		window.addEventListener('focus', observe);
		return () => {
			document.removeEventListener('visibilitychange', observe);
			window.removeEventListener('focus', observe);
		};
	});
	$effect(() => {
		if (!mounted) return;
		connected = client.connectionState().isWebSocketConnected;
		return client.subscribeToConnectionState((state) => {
			connected = state.isWebSocketConnected;
		});
	});
	onDestroy(() => {
		active = false;
		wordAttempt?.abort();
	});
	const stateReconciled = $derived(
		Boolean(
			auth.isAuthenticated &&
			!runtime.paused &&
			metadata.data &&
			!metadata.error &&
			persistence.confirmed.stateVersion >= metadata.data.stateVersion
		)
	);
	const editable = $derived(persistence.editable && stateReconciled && notifiedVisible);
	let resolutionError = $state<string | null>(null);
	const feedback = $derived<OperationStatus | null>(
		persistence.selectionLimitError || resolutionError
			? { message: persistence.selectionLimitError ?? resolutionError!, urgent: true }
			: null
	);
	async function loadLatest() {
		if (runtime.paused || session.blocked || !stateReconciled) return;
		resolutionError = null;
		if (!(await persistence.useConfirmedState()) && active)
			resolutionError = 'We couldn’t load the latest contract state. Your changes are still here.';
	}
	let animateInspectorContent = $state(false);
	let selectedItemId = $state<string | null>(null),
		selectedAnnotationId = $state<string | null>(null);
	const item = $derived(source.items?.find((i) => i._id === selectedItemId));
	const inspectorVisible = $derived(Boolean(item));
	$effect(() => {
		if (
			item &&
			selectedAnnotationId &&
			!documentAnnotations(item).some((annotation) => annotation.id === selectedAnnotationId)
		)
			selectedAnnotationId = null;
		if (selectedItemId && !item) {
			animateInspectorContent = false;
			selectedItemId = null;
			selectedAnnotationId = null;
		}
	});
	const reasons = $derived.by(() => {
		if (!item || !source.renderSource) return {};
		try {
			return Object.fromEntries(
				item.concessions.map((c) => {
					const blocked = conflictsForConcession(
						source.renderSource!.sourceIndex,
						source.renderSource!.items,
						persistence.choices,
						item._id,
						c.id
					);
					return [
						c.id,
						blocked.length
							? `Remove ${blocked.map((b) => '“' + (source.items?.find((i) => i._id === b.itemId)?.concessions.find((x) => x.id === b.concession.id)?.description ?? 'another concession') + '”').join(' and ')} first.`
							: ''
					];
				})
			);
		} catch {
			return Object.fromEntries(
				item.concessions.map((c) => [c.id, 'Contract source is unavailable.'])
			);
		}
	});
	function toggle(id: string) {
		if (!item || !editable) return;
		if (persistence.choices[item._id] !== id && reasons[id]) return;
		persistence.select(item._id, id);
	}
	function selectClause(itemId: string, annotationId: string) {
		if (!editable) return false;
		animateInspectorContent = inspectorVisible && selectedItemId !== itemId;
		selectedItemId = itemId;
		selectedAnnotationId = annotationId;
	}
	function close(restoreFocus = true) {
		if (restoreFocus) viewer.restoreAnnotationFocus?.();
		animateInspectorContent = false;
		selectedItemId = null;
		selectedAnnotationId = null;
	}

	const isAdmin = $derived(accountViewer().membership.role === 'admin');
	const reviews: ContractReviewController = new ContractReviewController({
		client,
		membershipId,
		contractId,
		persistence,
		isAdmin: () => isAdmin,
		canReview: () => canReview,
		preflight: checkDeal,
		canRequest: () => approvalEligibilityReason === null,
		tags: () => reviewTags
	});
	onDestroy(() => reviews.destroy());
	let dismissedCompletion = $state<number | null>(null);
	const awaitingCompletion = $derived(reviews.completion);
	const completionGeneration = $derived(reviews.completionGeneration);
	$effect(() => {
		persistence.confirmed;
		isAdmin;
		reviews.reconcile();
	});
	let reviewedLink = false;
	let reviewLinkMessage = $state<string | null>(null);
	const canReview = $derived(
		!persistence.workBlock &&
			isAdmin &&
			editable &&
			!persistence.pending &&
			!persistence.error &&
			connected &&
			viewer.interactionEnabled &&
			!session.blocked
	);
	const reviewApplications = $derived(
		selectedReviewApplications(snapshot.items, persistence.choices)
	);
	const reviewGutter = $derived(reviewApplications.length ? REVIEW_GUTTER_WIDTH : 0);
	const reviewTags = $derived.by<ReviewTag[]>(() =>
		reviewApplications.map(({ item, concession, concessionPosition, target: range }) => {
			const applicationId = persistence.intent[item._id]?.applicationId ?? '';
			const saved =
				persistence.confirmed.applications[item._id]?.concessionId === concession.id &&
				persistence.confirmed.applications[item._id]?.approval?.applicationId === applicationId;
			return {
				itemId: item._id,
				concessionId: concession.id,
				concessionPosition,
				applicationId,
				status:
					!saved && isAdmin && persistence.pending
						? 'approved'
						: reviewStatus(persistence.confirmed, item._id, concession.id, applicationId),
				description: concession.description,
				target: range,
				admin: isAdmin,
				disabled: !canReview || reviews.deciding || reviews.completionBusy
			};
		})
	);
	const savedReviewTags = $derived(savedReviews(snapshot.items, persistence.confirmed));
	const approvalCount = $derived(savedReviewTags.filter((t) => t.status !== 'approved').length);
	const pendingApprovalCount = $derived(
		savedReviewTags.filter((t) => t.status === 'pending').length
	);
	const rejectedApprovalCount = $derived(
		savedReviewTags.filter((t) => t.status === 'rejected').length
	);
	const approvalNeeded = $derived(approvalCount > 0);
	$effect(() => {
		if (pendingApprovalCount) reviewLinkMessage = null;
	});
	$effect(() => {
		if (
			reviewedLink ||
			page.url.searchParams.get('review') !== '1' ||
			!stateReconciled ||
			!viewer.interactionEnabled ||
			persistence.pending
		)
			return;
		reviewedLink = true;
		if (!pendingApprovalCount) reviewLinkMessage = 'There are no concessions waiting for review.';
		untrack(() => {
			reviews.navigation = {};
		});
	});

	const matchingApproval = $derived(
		latestApproval &&
			approvalCoversPending(
				savedReviewTags.filter((t) => t.status === 'pending'),
				latestApproval.selectedConcessions
			)
			? latestApproval
			: null
	);
	const approvalSending = $derived(reviews.requesting || latestApproval?.status === 'sending');
	const approvalRequested = $derived(matchingApproval?.status === 'sent');
	const approvalButtonLabel = $derived.by(() => {
		if (approvalSending) return 'Sending approval request…';
		if (approvalRequested) return 'Approval requested';
		if (latestApproval?.status === 'uncertain' && !latestApproval.retryEligible)
			return 'Approval delivery uncertain';
		if (latestApproval?.status === 'uncertain' || matchingApproval?.status === 'failed')
			return 'Retry approval request';
		return 'Ask for approval';
	});
	const approvalErrorMessage = $derived.by(() => {
		if (reviews.requestError) return reviews.requestError;
		if (approvalQuery.error)
			return 'We couldn’t check approval request status. Reconnect or reload to try again.';
		if (approvalSending) return null;
		if (latestApproval?.status === 'uncertain')
			return latestApproval.retryEligible
				? 'Email delivery could not be confirmed. You can retry now; another request may deliver a duplicate email.'
				: latestApproval.error;
		return matchingApproval?.status === 'failed' ? matchingApproval.error : null;
	});
	const approvalMessage = $derived(
		rejectedApprovalCount > 0
			? rejectedApprovalCount === 1
				? 'Your concession was declined. Remove it before downloading.'
				: 'Your concessions were declined. Remove them before downloading.'
			: !approvalSending && approvalRequested
				? 'Approval has been requested. Waiting for approval before download.'
				: approvalNeeded
					? `${approvalCount === 1 ? 'This concession requires' : 'These concessions require'} approval before download.`
					: null
	);
	const approvalRetryBlocked = $derived(
		latestApproval &&
			['failed', 'uncertain'].includes(latestApproval.status) &&
			!latestApproval.retryEligible
	);
	$effect(() => {
		persistence.choices;
		persistence.confirmed.buyerCompanyName;
		reviews.requestError = null;
	});
	let exportError = $state<string | null>(null);
	let wordAttempt = $state.raw<ReadAttempt | null>(null);
	const preparingWord = $derived(wordAttempt !== null);
	const actionDisabledReason = $derived.by(() => {
		if (persistence.deleted) return 'This contract was deleted.';
		if (persistence.blockedReason) return persistence.blockedReason;
		if (session.blocked) return 'Reconnect to your account to continue.';
		if (!connected) return 'Reconnect to continue.';
		if (persistence.conflict) return 'Resolve the conflicting changes before continuing.';
		if (persistence.error || metadata.error)
			return 'Changes could not be saved or loaded. Resolve the error before continuing.';
		if (persistence.pending) return 'Waiting for your changes to finish saving.';
		if (!stateReconciled) return 'Waiting for the contract to finish updating.';
		if (navigating.to) return 'Please wait while the next page opens.';
		return null;
	});
	const approvalEligibilityReason = $derived.by(() => {
		if (latestApproval?.status === 'sending') return 'Your approval request is being sent.';
		if (!pendingApprovalCount)
			return rejectedApprovalCount
				? 'The selected concessions were declined. Remove them or choose other concessions to request approval again.'
				: 'There are no concessions waiting for approval.';
		if (approvalRequested) return 'Approval has already been requested. Waiting for a decision.';
		if (actionDisabledReason) return actionDisabledReason;
		if (approvalQuery.error)
			return (
				approvalErrorMessage ??
				'We couldn’t check approval request status. Reconnect or reload to try again.'
			);
		if (approvalQuery.data === undefined) return 'Checking approval request status.';
		if (approvalRetryBlocked)
			return approvalErrorMessage ?? 'Please wait before retrying the approval request.';
		return null;
	});
	const approvalDisabledReason = $derived(
		reviews.requesting ? 'Your approval request is being sent.' : approvalEligibilityReason
	);
	// Export readiness excludes document preparation so starting a download does not abort it.
	const exportDisabledReason = $derived(
		actionDisabledReason ??
			(approvalNeeded ? 'Your concessions need to be approved before downloading' : null)
	);
	const downloadDisabledReason = $derived(
		preparingWord ? 'Your Word document is being prepared.' : exportDisabledReason
	);
	const exportReady = $derived(exportDisabledReason === null);
	const canExport = $derived(downloadDisabledReason === null);
	const canRequestApproval = $derived(approvalDisabledReason === null);
	let approvalHintTrigger = $state<HTMLSpanElement>();
	let downloadHintTrigger = $state<HTMLSpanElement>();

	$effect(() => {
		const revision = persistence.confirmed.editRevision;
		const generation = session.transportGeneration;
		const ready = exportReady;
		untrack(() => {
			exportError = null;
			if (wordAttempt && (!ready || revision !== wordRevision || generation !== wordGeneration)) {
				wordAttempt.abort();
				wordAttempt = null;
			}
		});
	});
	let wordRevision = 0;
	let wordGeneration = 0;
	async function downloadSavedWord() {
		if (!active || !canExport) return;
		const attempt = new ReadAttempt(30_000);
		wordRevision = persistence.confirmed.editRevision;
		wordGeneration = session.transportGeneration;
		wordAttempt = attempt;
		const identity =
			exportIdentity?.revision === wordRevision
				? exportIdentity
				: (exportIdentity = { operationId: crypto.randomUUID(), revision: wordRevision });
		exportError = null;
		try {
			await waitForRead(checkDeal(), attempt.signal);
			if (
				attempt.signal.aborted ||
				!active ||
				wordAttempt !== attempt ||
				!exportReady ||
				persistence.confirmed.editRevision !== wordRevision ||
				session.transportGeneration !== wordGeneration
			)
				return;
			const generation = client
				.action(api.wordExport.generate, {
					membershipId,
					id: contractId,
					expectedEditRevision: wordRevision,
					operationId: identity.operationId
				})
				.catch((error) => {
					// Observe authoritative retirement even after the foreground waiter is canceled.
					if (
						exportIdentity === identity &&
						(errorCode(error) === 'DOWNLOAD_ATTEMPT_RETIRED' ||
							(error instanceof ConvexError &&
								typeof error.data === 'string' &&
								/expired|unavailable|changed/.test(error.data)))
					)
						exportIdentity = null;
					throw error;
				});
			const result = await waitForRead(generation, attempt.signal);
			const response = await fetch(result.url, { signal: attempt.signal, cache: 'no-store' });
			if (!response.ok) throw new Error('Download failed.');
			const blob = await waitForRead(response.blob(), attempt.signal);
			if (
				attempt.signal.aborted ||
				!active ||
				wordAttempt !== attempt ||
				!exportReady ||
				persistence.confirmed.editRevision !== wordRevision ||
				session.transportGeneration !== wordGeneration
			)
				return;
			downloadWord(blob, result.filename);
			journalDownload(membershipId, result.attemptId, Date.now());
			void flushDownloadAcks(client, membershipId);
			if (exportIdentity === identity) exportIdentity = null;
		} catch (error) {
			if (active && wordAttempt === attempt)
				exportError = saveError(error, 'We couldn’t prepare this download. Try again.');
		} finally {
			attempt.abort();
			if (wordAttempt === attempt) wordAttempt = null;
		}
	}

	$effect(() => {
		if (!session.blocked) void flushDownloadAcks(client, membershipId);
	});
</script>

{#if repairHubSpot}<HubSpotRelink
		{contractId}
		link={persistence.confirmed.hubspot}
		onClose={() => (repairHubSpot = false)}
	/>{/if}

<BoxDismissal owner={interactionOwner} active={inspectorVisible} onDismiss={close} />

<WorkspacePresentationReporter
	active={interactionAdmitted && !runtime.paused}
	outcome={presentationOutcome}
/>

{#if interactionAdmitted && !runtime.paused}
	<WorkspaceChrome {feedback} helpVariant="rep" helpReady={notifiedVisible} />
	{#if !persistence.deleted && persistence.workBlock}
		<HeaderContent placement="notice">
			<div
				class="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 border-t-[length:var(--surface-border-width)] border-line bg-[color-mix(in_srgb,var(--color-accent)_5%,white)] px-3 py-2.5 text-[12.5px] font-normal leading-relaxed text-ink sm:px-5"
			>
				<p class="min-w-0 flex-1 basis-[400px]" role="status" aria-live="polite" aria-atomic="true">
					{persistence.blockedReason}
				</p>
				<Button
					variant="secondary"
					aria-haspopup="dialog"
					onclick={() => (repairHubSpot = true)}
					class="h-[31px] rounded-[7px]! self-center px-[9.5px] py-1 text-[11.75px] shadow-none not-disabled:not-aria-disabled:hover:bg-field-hover disabled:bg-field-hover"
					>{persistence.confirmed.hubspot ? 'Link another deal' : 'Link a deal'}</Button
				>
			</div>
		</HeaderContent>
	{/if}
{/if}
{#if persistence.deleted}<p
		role="alert"
		class="mx-auto mt-4 max-w-3xl rounded-md border-hairline border-edge bg-surface p-3 shadow-card text-sm"
	>
		This contract was deleted. <a class="underline" href="/">Back to Home</a>
	</p>
{:else if persistence.conflict}<div
		role="alert"
		class="mx-auto mt-4 max-w-3xl rounded-md border-hairline border-edge bg-surface p-3 shadow-card text-sm"
	>
		This contract changed elsewhere. Choose which selections to keep.
		<button
			class="ml-2 underline disabled:text-ink-muted"
			disabled={session.blocked || !stateReconciled}
			onclick={() => void loadLatest()}>Use latest saved version</button
		>
		<button
			class="ml-2 underline disabled:text-ink-muted"
			disabled={session.blocked || !stateReconciled}
			onclick={() => {
				if (!session.blocked && stateReconciled) persistence.applyRecovered();
			}}>Apply my selections</button
		>
	</div>{/if}
{#if reviewLinkMessage}<p
		class="mx-auto mt-4 max-w-3xl text-center text-sm text-ink-muted"
		role="status"
	>
		{reviewLinkMessage}
	</p>{/if}
{#if awaitingCompletion && !persistence.deleted}
	<p class="mx-auto mt-4 max-w-3xl text-center text-sm text-ink-muted" role="status">
		<button class="underline" onclick={() => (dismissedCompletion = null)}>
			Review results awaiting confirmation
		</button>
	</p>
{/if}
{#if !persistence.deleted}
	<InteractionInputScope
		capture={(event) => {
			if (event.type === 'click') recordContractInput(event);
		}}
	>
		<main
			class="pt-14 pb-16 [--workspace-loading-inset:calc(var(--spacing)*30)] min-[1000px]:pt-6 min-[1000px]:[--workspace-loading-inset:calc(var(--spacing)*22)]"
			onclickcapture={recordContractInput}
			aria-label="Contract document"
		>
			{#snippet panelContent()}{#if item}<RepPlaybookPanel
						{item}
						animateContent={animateInspectorContent}
						{isAdmin}
						selected={persistence.choices[item._id]}
						disabled={!editable}
						conflicts={reasons}
						onToggle={toggle}
						onClose={() => close()}
					/>{/if}{/snippet}
			{#snippet footerContent()}
				<div
					class="pt-6"
					role="group"
					aria-label="Contract actions"
					aria-busy={preparingWord || approvalSending}
				>
					<div class="flex flex-wrap items-center justify-center gap-3">
						<Tooltip
							text={approvalDisabledReason ?? ''}
							trigger={approvalHintTrigger}
							standalone={false}
							enabled={!canRequestApproval}
							class="rounded-md border-hairline border-edge bg-surface px-2 py-1 text-left text-xs leading-[1.4] text-ink shadow-floating"
						>
							{#snippet children(descriptionId)}
								<!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users focus this wrapper to read why the native disabled button is unavailable.) -->
								<span
									bind:this={approvalHintTrigger}
									class="inline-flex rounded-button-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
									role="group"
									tabindex={!canRequestApproval ? 0 : undefined}
									aria-label={approvalButtonLabel}
									aria-describedby={!canRequestApproval ? descriptionId : undefined}
								>
									<Button
										class="bg-accent text-white not-disabled:not-aria-disabled:hover:bg-accent-hover h-11 px-5 text-sm disabled:pointer-events-none"
										disabled={!canRequestApproval}
										aria-describedby={!canRequestApproval ? descriptionId : undefined}
										aria-live="polite"
										onclick={() => void reviews.requestApproval()}
									>
										{approvalButtonLabel}
									</Button>
								</span>
							{/snippet}
						</Tooltip>
						<Tooltip
							text={downloadDisabledReason ?? ''}
							trigger={downloadHintTrigger}
							standalone={false}
							enabled={!canExport}
							class="rounded-md border-hairline border-edge bg-surface px-2 py-1 text-left text-xs leading-[1.4] text-ink shadow-floating"
						>
							{#snippet children(descriptionId)}
								<!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users focus this wrapper to read why the native disabled button is unavailable.) -->
								<span
									bind:this={downloadHintTrigger}
									class="inline-flex rounded-button-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
									role="group"
									tabindex={!canExport ? 0 : undefined}
									aria-label="Download as .docx"
									aria-describedby={!canExport ? descriptionId : undefined}
								>
									<Button
										class="bg-accent text-white not-disabled:not-aria-disabled:hover:bg-accent-hover h-11 px-5 text-sm disabled:pointer-events-none"
										disabled={!canExport}
										aria-describedby={!canExport ? descriptionId : undefined}
										onclick={() => void downloadSavedWord()}>Download as .docx</Button
									>
								</span>
							{/snippet}
						</Tooltip>
					</div>
					{#if approvalErrorMessage}
						<p class="mt-3 text-center text-sm text-ink-muted" role="alert">
							{approvalErrorMessage}
						</p>
					{/if}
					{#if approvalMessage}
						<p class="mt-3 text-center text-sm text-ink-muted" role="status">
							{approvalMessage}
						</p>
					{/if}

					{#if reviews.decisionError}<p
							class="mt-3 text-center text-sm text-ink-muted"
							role="alert"
						>
							{reviews.decisionError.message}
						</p>{/if}
					{#if preparingWord}
						<p class="mt-3 text-center text-sm text-ink-muted" role="status">
							Preparing Word download…
						</p>
					{:else if exportError}
						<p class="mt-3 text-center text-sm text-ink-muted" role="alert">{exportError}</p>
					{/if}
				</div>
			{/snippet}
			{#if source.issue && !source.renderSource}<p role="alert">
					We couldn’t load this contract. Please refresh to try again.
				</p>{:else}<DocumentViewerSlot
					{attachment}
					entry={resource}
					active={!runtime.paused}
					onPresentation={(outcome) => (viewerPresentation = outcome)}
					prepare={!runtime.paused}
					interactive={interactionAdmitted &&
						stateReconciled &&
						(notifiedVisible || Boolean(workspace.renderer.error))}
					hasPanel={inspectorVisible}
					{panelContent}
					{footerContent}
					{selectedAnnotationId}
					{reviewTags}
					{reviewGutter}
					reviewNavigation={reviews.navigation}
					onReviewDecision={(tag, status) => void reviews.decide(tag, status)}
					selectedConcessions={persistence.choices}
					allowPlaybookNavigation
					playbookNavigationReady={editable}
					onRemoveConcession={(itemId) => {
						if (editable) persistence.select(itemId as Id<'playbookItems'>, null);
					}}
					panelTarget={item?.trigger.target}
					onSelect={selectClause}
					onDocumentBackground={() => close(false)}
				/>{/if}
		</main>
	</InteractionInputScope>
{/if}

{#if awaitingCompletion && completionGeneration !== dismissedCompletion && !runtime.paused && !session.blocked && !navigating.to && !persistence.deleted}
	{#key completionGeneration}
		<ReviewCompletedModal
			busy={reviews.completionBusy}
			disabled={!canReview || reviews.deciding}
			error={reviews.completionError}
			onSend={() => void reviews.resolveCompletion(false)}
			onReset={() => void reviews.resolveCompletion(true)}
			onClose={() => (dismissedCompletion = completionGeneration)}
		/>
	{/key}
{/if}
