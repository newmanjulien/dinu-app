<script lang="ts">
	import { documentAnnotations } from '$lib/playbook/document-overlay';
	import { onDestroy, onMount, untrack } from 'svelte';
	import { navigating, page } from '$app/state';
	import { useAuth, useConvexClient, useQuery } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import type { Id } from '../../../convex/_generated/dataModel';
	import type { ContractSnapshot } from '$lib/contract/saved';
	import type { ContractSession } from '$lib/contract/sessions.svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { recordOpening } from '$lib/contract/browser-storage';
	import type { OperationStatus } from '$lib/components/chrome/operation-status';
	import { createContractWorkspace, setContractWorkspace } from '$lib/document/runtime/context';
	import { conflictsForConcession } from '$lib/playbook/selection-conflicts';
	import { getDocumentResources } from '$lib/document/runtime/resources.svelte';
	import { getWorkspaceRuntime } from '$lib/auth/workspace-context.svelte';
	import DocumentViewerSlot from '$lib/components/document/DocumentViewerSlot.svelte';
	import LoadingPagination from '$lib/components/document/LoadingPagination.svelte';
	import BoxDismissal from '$lib/components/playbook/BoxDismissal.svelte';
	import RepPlaybookPanel from '$lib/components/playbook/RepPlaybookPanel.svelte';
	import WorkspaceChrome from './WorkspaceChrome.svelte';
	import { recordContractInput } from '$lib/document/runtime/render-perf';
	import { setInteractionOwner } from '$lib/components/ui/interactions';
	import { sameSelection } from '$lib/playbook/model';
	import { downloadWord } from '$lib/contract/export/download';
	import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
	import {
		approvalCoversPending,
		savedReviews,
		reviewStatus,
		type ReviewTag,
		type ReviewDecision,
		type ReviewNavigation
	} from '$lib/contract/approval';
	import { saveError } from '$lib/contract/saved';
	let {
		snapshot,
		session: contractSession,
		onVisible,
		onFailure
	}: {
		snapshot: ContractSnapshot;
		session: ContractSession;
		onVisible?: () => void;
		onFailure?: () => void;
	} = $props();
	const initialContract = untrack(() => contractSession.metadata!);
	const persistence = untrack(() => contractSession.persistence!);
	const metadata = {
		get data() {
			return contractSession.metadata;
		},
		get error() {
			return contractSession.error;
		}
	};
	const runtime = getWorkspaceRuntime();
	const resources = getDocumentResources();
	const resource = resources
		? untrack(() =>
				resources.acquireContract({
					id: initialContract._id,
					status: 'ready',
					snapshot,
					contract: {
						...initialContract,
						lastOperationId: initialContract.lastOperationId ?? undefined
					}
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
	const approvalQuery = useQuery(api.approvals.latest, () =>
		mounted && auth.isAuthenticated && !runtime.paused ? { membershipId, id: contractId } : 'skip'
	);
	let requestingApproval = $state(false);
	let approvalError = $state<string | null>(null);
	const latestApproval = $derived(approvalQuery.data);
	$effect(() => attachment?.update(persistence.choices));
	let notifiedVisible = $state(false);
	let recordedOpening = false;
	const displayedStateReconciled = $derived.by(() => {
		const displayed = viewer.displayedSnapshot;
		return Boolean(
			stateReconciled &&
			!persistence.recoveryPending &&
			viewer.visible &&
			viewer.prepared &&
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
			viewer.ready &&
			!persistence.pending &&
			!persistence.deleted &&
			!workspace.renderer.error &&
			!source.issue &&
			!recordedOpening
		) {
			recordedOpening = true;
			untrack(() => {
				recordOpening(contractId);
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
	let connected = $state(false);
	let active = true;
	onMount(() => {
		mounted = true;
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
			persistence.confirmed.revision >= metadata.data.revision
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
		if (!(await persistence.loadLatest()) && active)
			resolutionError = 'We couldn’t load the latest contract state. Your changes are still here.';
	}
	let selectedItemId = $state<string | null>(null),
		selectedAnnotationId = $state<string | null>(null);
	const item = $derived(source.items?.find((i) => i._id === selectedItemId));
	$effect(() => {
		if (
			item &&
			selectedAnnotationId &&
			!documentAnnotations(item).some((annotation) => annotation.id === selectedAnnotationId)
		)
			selectedAnnotationId = null;
		if (selectedItemId && !item) {
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
	function close(restoreFocus = true) {
		if (restoreFocus) viewer.restoreAnnotationFocus?.();
		selectedItemId = null;
		selectedAnnotationId = null;
	}

	const isAdmin = $derived(accountViewer().profile.role === 'admin');
	type DecisionAttempt = {
		operationId: string;
		concessionId: string;
		lifecycle: string;
		status: ReviewDecision;
	};
	let deciding = $state(false);
	let decisionError = $state.raw<{
		itemId: string;
		attempt: DecisionAttempt;
		changesStatus: boolean;
		message: string;
	} | null>(null);
	let reviewNavigation = $state.raw<ReviewNavigation>();
	let reviewedLink = false;
	let reviewLinkMessage = $state<string | null>(null);
	const canReview = $derived(
		isAdmin &&
			editable &&
			!persistence.pending &&
			!persistence.error &&
			connected &&
			viewer.ready &&
			!session.blocked
	);
	const reviewApplications = $derived.by(() => {
		if (!source.renderSource?.sourceIndex) return [];
		return snapshot.items.flatMap((item) => {
			const selected = persistence.choices[item._id];
			if (!selected || !item.instructions?.changesNeedApproval?.trim()) return [];
			const concessionPosition = item.concessions.findIndex((c) => c.id === selected);
			const concession = item.concessions[concessionPosition];
			if (!concession) return [];
			const range = concession.changes[0]?.range ?? item.triggers[0]?.range;
			if (!range) return [];
			return [
				{
					item,
					concession,
					concessionPosition,
					range
				}
			];
		});
	});
	const reviewTags = $derived.by<ReviewTag[]>(() =>
		reviewApplications.map(({ item, concession, concessionPosition, range }) => {
			const lifecycle = persistence.lifecycles[item._id];
			const saved =
				persistence.confirmed.selectedConcessions[item._id] === concession.id &&
				persistence.confirmed.reviews[item._id]?.lifecycle === lifecycle;
			return {
				itemId: item._id,
				concessionId: concession.id,
				concessionPosition,
				lifecycle,
				status:
					!saved && isAdmin && persistence.pending
						? 'approved'
						: reviewStatus(persistence.confirmed, item._id, concession.id, lifecycle),
				description: concession.description,
				range,
				admin: isAdmin,
				disabled: !canReview || deciding
			};
		})
	);
	const savedReviewTags = $derived(savedReviews(snapshot.items, persistence.confirmed));
	const approvalCount = $derived(savedReviewTags.filter((t) => t.status !== 'approved').length);
	const pendingApprovalCount = $derived(
		savedReviewTags.filter((t) => t.status === 'pending').length
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
			!viewer.ready ||
			persistence.pending
		)
			return;
		reviewedLink = true;
		if (!pendingApprovalCount) reviewLinkMessage = 'There are no concessions waiting for review.';
		untrack(() => {
			reviewNavigation = {};
		});
	});
	// Reuse an ambiguous operation only for the exact same decision and lifecycle.
	const decisionAttempts = new Map<string, DecisionAttempt>();
	function decisionSettled(itemId: string, attempt: DecisionAttempt, changesStatus = true) {
		const confirmed = persistence.confirmed;
		return (
			confirmed.selectedConcessions[itemId as Id<'playbookItems'>] !== attempt.concessionId ||
			confirmed.reviews[itemId as Id<'playbookItems'>]?.lifecycle !== attempt.lifecycle ||
			(changesStatus &&
				reviewStatus(confirmed, itemId, attempt.concessionId, attempt.lifecycle) === attempt.status)
		);
	}
	$effect(() => {
		persistence.confirmed;
		for (const [itemId, attempt] of decisionAttempts) {
			if (decisionSettled(itemId, attempt)) decisionAttempts.delete(itemId);
		}
		if (
			decisionError &&
			decisionSettled(decisionError.itemId, decisionError.attempt, decisionError.changesStatus)
		)
			decisionError = null;
	});
	async function decideReview(tag: ReviewTag, status: ReviewDecision) {
		const current = reviewTags.find(
			(t) =>
				t.itemId === tag.itemId &&
				t.lifecycle === tag.lifecycle &&
				t.concessionId === tag.concessionId
		);
		if (!active || !current || current.disabled) return;
		const prior = decisionAttempts.get(tag.itemId);
		const attempt =
			prior?.concessionId === tag.concessionId &&
			prior.lifecycle === tag.lifecycle &&
			prior.status === status &&
			reviewStatus(persistence.confirmed, tag.itemId, tag.concessionId, tag.lifecycle) !== status
				? prior
				: {
						operationId: crypto.randomUUID(),
						concessionId: tag.concessionId,
						lifecycle: tag.lifecycle,
						status
					};
		// A decision already visible in live state is a fresh acknowledgement,
		// even when the server has no metadata change to publish for this click.
		const changesStatus = current.status !== status;
		if (changesStatus) decisionAttempts.set(tag.itemId, attempt);
		else decisionAttempts.delete(tag.itemId);
		deciding = true;
		decisionError = null;
		try {
			await client.mutation(api.approvals.decide, {
				membershipId,
				id: contractId,
				itemId: tag.itemId as Id<'playbookItems'>,
				concessionId: tag.concessionId,
				lifecycle: tag.lifecycle,
				status,
				operationId: attempt.operationId
			});
			if (!active) return;
			decisionAttempts.delete(tag.itemId);
			reviewNavigation = { afterItemId: tag.itemId };
		} catch (error) {
			if (active && !decisionSettled(tag.itemId, attempt, changesStatus))
				decisionError = {
					itemId: tag.itemId,
					attempt,
					changesStatus,
					message: saveError(error, 'We couldn’t save this decision. Choose it again to retry.')
				};
		} finally {
			if (active) deciding = false;
		}
	}

	const matchingApproval = $derived(
		latestApproval &&
			approvalCoversPending(
				savedReviewTags.filter((t) => t.status === 'pending'),
				latestApproval.selectedConcessions
			)
			? latestApproval
			: null
	);
	const approvalSending = $derived(requestingApproval || latestApproval?.status === 'sending');
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
		if (approvalError) return approvalError;
		if (approvalQuery.error)
			return 'We couldn’t check approval request status. Reconnect or reload to try again.';
		if (approvalSending) return null;
		if (latestApproval?.status === 'uncertain')
			return latestApproval.retryEligible
				? 'Gmail delivery could not be confirmed. You can retry now; another request may deliver a duplicate email.'
				: latestApproval.error;
		return matchingApproval?.status === 'failed' ? matchingApproval.error : null;
	});
	const approvalMessage = $derived(
		!approvalSending && approvalRequested
			? 'Approval request sent.'
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
		persistence.confirmed.companyName;
		approvalError = null;
	});
	let exportError = $state<string | null>(null);
	let wordAttempt = $state.raw<ReadAttempt | null>(null);
	const preparingWord = $derived(wordAttempt !== null);
	const savedStateReady = $derived(
		!persistence.pending &&
			!persistence.error &&
			!persistence.conflict &&
			!persistence.deleted &&
			stateReconciled &&
			!metadata.error &&
			connected &&
			!session.blocked &&
			!navigating.to
	);
	const exportReady = $derived(savedStateReady && !approvalNeeded);
	const canExport = $derived(exportReady && !preparingWord);
	const canRequestApproval = $derived(
		pendingApprovalCount > 0 &&
			savedStateReady &&
			approvalQuery.data !== undefined &&
			!approvalQuery.error &&
			!approvalSending &&
			!approvalRetryBlocked &&
			!approvalRequested
	);
	async function askForApproval() {
		if (!active || session.blocked || !canRequestApproval) return;
		requestingApproval = true;
		approvalError = null;
		try {
			await client.mutation(api.approvals.request, {
				membershipId,
				id: contractId,
				expectedRevision: persistence.confirmed.revision
			});
		} catch (error) {
			if (active) approvalError = saveError(error, 'We couldn’t request approval. Try again.');
		} finally {
			if (active) requestingApproval = false;
		}
	}
	$effect(() => {
		const revision = persistence.confirmed.revision;
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
		wordRevision = persistence.confirmed.revision;
		wordGeneration = session.transportGeneration;
		wordAttempt = attempt;
		exportError = null;
		try {
			const result = await waitForRead(
				client.action(api.wordExport.generate, {
					membershipId,
					id: contractId,
					expectedRevision: wordRevision
				}),
				attempt.signal
			);
			const response = await fetch(result.url, { signal: attempt.signal, cache: 'no-store' });
			if (!response.ok) throw new Error('Download failed.');
			const blob = await waitForRead(response.blob(), attempt.signal);
			if (
				!active ||
				wordAttempt !== attempt ||
				!exportReady ||
				persistence.confirmed.revision !== wordRevision ||
				session.transportGeneration !== wordGeneration
			)
				return;
			downloadWord(blob, result.filename);
		} catch (error) {
			if (active && wordAttempt === attempt)
				exportError = saveError(error, 'We couldn’t prepare this download. Try again.');
		} finally {
			attempt.complete();
			if (wordAttempt === attempt) wordAttempt = null;
		}
	}
	const actionButtonClass =
		'cursor-pointer rounded-lg border border-accent bg-accent px-5 py-2.5 font-normal text-sm text-surface enabled:hover:border-accent-hover enabled:hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-accent disabled:cursor-default disabled:border-line disabled:bg-control-fill disabled:text-ink-muted';
</script>

<BoxDismissal owner={interactionOwner} active={Boolean(item)} onDismiss={close} />

{#if !runtime.paused}<WorkspaceChrome {feedback} />{/if}
{#if persistence.deleted}<p
		role="alert"
		class="mx-auto mt-4 max-w-3xl rounded-md border border-line bg-surface p-3 text-sm"
	>
		This contract was deleted. <a class="underline" href="/">Back to Home</a>
	</p>
{:else if persistence.conflict}<div
		role="alert"
		class="mx-auto mt-4 max-w-3xl rounded-md border border-line bg-surface p-3 text-sm"
	>
		This contract changed elsewhere. Choose which selections to keep.
		<button
			class="ml-2 underline disabled:opacity-50"
			disabled={session.blocked || !stateReconciled}
			onclick={() => void loadLatest()}>Use latest saved version</button
		>
		<button
			class="ml-2 underline disabled:opacity-50"
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
{#if source.renderSource && !persistence.deleted}
	<main onclickcapture={recordContractInput} aria-label="Contract document">
		{#snippet panelContent()}{#if item}<RepPlaybookPanel
					{item}
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
				<div class="flex flex-wrap justify-center gap-3">
					<button
						type="button"
						class={actionButtonClass}
						disabled={!canRequestApproval}
						aria-live="polite"
						onclick={askForApproval}
					>
						{approvalButtonLabel}
					</button>
					<button
						type="button"
						class={actionButtonClass}
						disabled={!canExport}
						onclick={() => void downloadSavedWord()}>Download as .docx</button
					>
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

				{#if decisionError}<p class="mt-3 text-center text-sm text-ink-muted" role="alert">
						{decisionError.message}
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
		<DocumentViewerSlot
			{attachment}
			entry={resource}
			active={!runtime.paused}
			prepare={!runtime.paused}
			interactive={stateReconciled && (notifiedVisible || Boolean(workspace.renderer.error))}
			hasPanel={Boolean(item)}
			{panelContent}
			{footerContent}
			{selectedAnnotationId}
			{reviewTags}
			{reviewNavigation}
			onReviewDecision={decideReview}
			selectedConcessions={persistence.choices}
			allowPlaybookNavigation
			playbookNavigationReady={editable}
			onRemoveConcession={(itemId) => {
				if (editable) persistence.select(itemId as Id<'playbookItems'>, null);
			}}
			panelSource={item?.triggers[0]?.range.start}
			onSelect={(id, trigger) => {
				if (!editable) return false;
				selectedItemId = id;
				selectedAnnotationId = trigger;
			}}
		/>
	</main>
{:else if source.issue && !persistence.deleted}<p role="alert">
		We couldn’t load this contract. Please refresh to try again.
	</p>{:else if !persistence.deleted}<LoadingPagination
		label="Loading contract"
		chrome={false}
	/>{/if}

<style>
	main {
		--document-padding-top: calc(var(--spacing) * 14);
		--document-padding-bottom: calc(var(--spacing) * 16);
		--workspace-loading-inset: calc(var(--document-padding-top) + var(--document-padding-bottom));
		padding-block: var(--document-padding-top) var(--document-padding-bottom);
	}

	@media (min-width: 1000px) {
		main {
			--document-padding-top: calc(var(--spacing) * 6);
		}
	}
</style>
