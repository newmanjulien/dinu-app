<script lang="ts">
	import { createOperationId } from '$lib/contract/operation-identity';
	import { assertOperationRetryable, isOperationRecovery } from '$lib/contract/operation-recovery';
	import { prepareContractAction } from '$lib/contract/prepare-action';
	import type { FunctionArgs } from 'convex/server';
	import { useReadQuery } from '$lib/auth/read-query.svelte';

	import { useAccountContext } from '$lib/auth/account-context.svelte';
	import { useHubSpotDeals } from '$lib/hubspot-deals.svelte';
	import BuyerLinkBarAdmission from './BuyerLinkBarAdmission.svelte';
	import type { BuyerLinkBarVisit } from '$lib/buyer/bar-visit.svelte';
	import { ConvexError } from 'convex/values';
	import { errorCode, workBlockMessage } from '$lib/contract/work-policy';
	import HubSpotRelink from './HubSpotRelink.svelte';
	import { journalDownload, flushDownloadAcks } from '$lib/contract/download-journal';
	let repairHubSpot = $state(false);
	let exportIdentity: {
		args: FunctionArgs<typeof api.wordExport.generate>;
		uncertain?: boolean;
	} | null = null;
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { ContractReviewController } from '$lib/contract/review-controller.svelte';
	import { documentAnnotations } from '$lib/playbook/document-overlay';
	import { onDestroy, onMount, untrack } from 'svelte';
	import { navigating, page } from '$app/state';
	import { useConvexClient, useQuery } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import type { Id } from '../../../convex/_generated/dataModel';
	import type { ContractEditor } from '$lib/contract/editors.svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { getContractOpenings } from '$lib/contract/snapshot-cache';
	import type { OperationStatus } from '$lib/components/chrome/operation-status';
	import { ContractReviewPages } from '$lib/contract/review-pages.svelte';
	import { getWorkspaceRuntime } from '$lib/auth/workspace-context.svelte';
	import { REVIEW_GUTTER_WIDTH } from '$lib/components/document/workspace-layout';
	import BoxDismissal from '$lib/components/playbook/BoxDismissal.svelte';
	import RepPlaybookPanel from '$lib/components/playbook/RepPlaybookPanel.svelte';
	import ReviewCompletedModal from '$lib/components/ui/modal/ReviewCompletedModal.svelte';
	import HeaderContent from '$lib/components/chrome/HeaderContent.svelte';
	import NoticeBar from '$lib/components/chrome/NoticeBar.svelte';
	import { getInteractionOwner } from '$lib/components/ui/interactions';
	import { sameSelection } from '$lib/playbook/model';
	import { downloadWord } from '$lib/document/export/download';
	import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
	import { continueOutputAction } from '$lib/contract/output-action';
	import Button from '$lib/ui/Button.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import type { ReviewTag } from '$lib/contract/approval';
	import { saveError } from '$lib/contract/saved';
	import { getDocumentWorkspace } from '$lib/document/runtime/workspace-context';
	import type { ViewerBindings } from '$lib/document/runtime/resources.svelte';
	let {
		editor: contractEditor,
		buyerLinkVisit,
		latestBuyerLink,
		interactionAdmitted = true,
		onVisible,
		onFailure,
		onRetry,
		openingRevision,
		onBindings,
		onChrome
	}: {
		editor: ContractEditor;
		buyerLinkVisit?: BuyerLinkBarVisit;
		latestBuyerLink: ReturnType<typeof useReadQuery<typeof api.buyerLinks.latest>>;
		interactionAdmitted?: boolean;
		onVisible?: () => void;
		openingRevision?: unknown;
		onFailure?: () => void;
		onRetry: () => void;
		onBindings: (bindings: ViewerBindings) => void;
		onChrome: (chrome: {
			feedback: OperationStatus | null;
			onDownload?: () => void;
			downloadReason: string | null;
		}) => void;
	} = $props();
	const initialContract = untrack(() => contractEditor.metadata!);
	const contractItems = $derived(
		contractEditor.items.filter((item) => item.origin.kind === 'template')
	);
	const renderChoices = $derived(contractEditor.renderChoices);
	const definitionsReady = $derived(contractEditor.definitionsReady);
	const definitionsFailed = $derived.by(() => {
		const input = contractEditor.documentInput;
		return !definitionsReady && input.kind === 'records' && Boolean(input.items.error);
	});
	const persistence = untrack(() => contractEditor.persistence!);
	const saveNotice = $derived(contractEditor.notice);
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
	const interactionOwner = getInteractionOwner()!;
	const workspace = getDocumentWorkspace();

	const { source, viewer } = workspace;
	const client = useConvexClient();
	const auth = useAccountContext()!;
	const session = useViewerSession();
	const accountViewer = useViewer();
	const membershipId = accountViewer().membership.id;
	const contractId = untrack(() => initialContract._id);
	const buyerLinkAvailable = $derived(
		!runtime.paused && !persistence.deleted && !persistence.workBlock
	);
	const exportStatus = useReadQuery(api.contractExports.status, () =>
		auth.authenticated && !runtime.paused ? { membershipId, id: contractId } : 'skip'
	);

	const hubspot = useHubSpotDeals();
	const hubspotConnection = hubspot.connection;
	const quotesInstalled = $derived(Boolean(hubspotConnection.data?.quotes?.installed));
	let quoteId = $state<Id<'hubspotQuotePushes'>>();
	let pushingQuote = $state(false);
	let quoteAttempt = $state.raw<ReadAttempt | null>(null);
	let quoteGeneration = 0;
	let quoteDispatched = $state(false);
	let quoteError = $state<string | null>(null);
	let quoteIdentity: {
		args: FunctionArgs<typeof api.hubspotQuoteActions.push>;
		uncertain?: boolean;
	} | null = null;
	const quoteQuery = useQuery(api.hubspotQuotes.latest, () =>
		auth.authenticated && quotesInstalled && !runtime.paused
			? { membershipId, id: contractId, ...(quoteId ? { pushId: quoteId } : {}) }
			: 'skip'
	);
	const quote = $derived(quoteQuery.data);
	const quotePending = $derived(
		Boolean(quote && ['queued', 'dispatched', 'verifying'].includes(quote.state))
	);
	const quoteFeedback = $derived.by((): OperationStatus | null => {
		if (!quotesInstalled) return null;
		if (quoteError) return { message: quoteError, urgent: true };
		if (pushingQuote || quotePending)
			return {
				message:
					quote?.state === 'verifying'
						? 'Quote created. Verifying the contract in HubSpot…'
						: 'Preparing your HubSpot quote…'
			};
		if (quoteQuery.error)
			return {
				message: 'We couldn’t check your HubSpot quote. Reload to check its status.',
				urgent: true
			};
		if (!quote) return null;
		const currentQuote = quote;
		const actions: NonNullable<OperationStatus['actions']> = currentQuote.url
			? [
					{
						label: 'Open in HubSpot',
						run: () => window.open(currentQuote.url!, '_blank', 'noopener,noreferrer')
					}
				]
			: [];
		if (quote.state === 'attention')
			actions.push({
				label: 'Check status',
				run: () => {
					void client
						.mutation(api.hubspotQuotes.check, { membershipId, id: currentQuote.id })
						.catch((error) => {
							quoteError = saveError(error, 'We couldn’t check this quote. Try again.');
						});
				}
			});
		return {
			message:
				quote.state === 'verified'
					? 'Quote created. Review the contract and complete pricing, recipients and sending in HubSpot.'
					: (quote.message ?? 'Review this quote in HubSpot.'),
			urgent: ['unknown', 'attention', 'rejected'].includes(quote.state),
			actions
		};
	});
	async function prepareSource(signal?: AbortSignal) {
		await checkDeal();
		return prepareContractAction({
			client,
			membershipId,
			id: contractId,
			signal,
			flush: () => contractEditor.savePending(),
			hasLocalIntent: () => contractEditor.pending || persistence.conflict,
			current: () => active && !session.blocked && !runtime.paused
		});
	}
	async function pushQuote() {
		if (!active || quoteDisabledReason) return;
		const attempt = new ReadAttempt(30_000);
		quoteGeneration = session.transportGeneration;
		quoteAttempt = attempt;
		quoteDispatched = false;
		pushingQuote = true;
		quoteError = null;
		exportError = null;
		try {
			if (!quoteIdentity) {
				const expectedSource = await waitForRead(prepareSource(attempt.signal), attempt.signal);
				if (
					!active ||
					attempt.signal.aborted ||
					quoteAttempt !== attempt ||
					session.transportGeneration !== quoteGeneration
				)
					return;
				const destination = persistence.confirmed.hubspot;
				if (!destination || destination.availability !== 'available')
					throw new ConvexError('Choose an available HubSpot deal before continuing.');
				const { availability, ...capturedDestination } = destination;
				quoteIdentity = {
					args: {
						membershipId,
						id: contractId,
						expectedSource,
						destination: capturedDestination,
						operationId: createOperationId()
					}
				};
			}
			const identity = quoteIdentity;
			assertOperationRetryable(identity.args.operationId);
			quoteDispatched = true;
			// The enclosing owner remains cancelable; each bounded action owns its timeout.
			attempt.complete();
			const result = await continueOutputAction(
				() =>
					(assertOperationRetryable(identity.args.operationId),
					client.action(api.hubspotQuoteActions.push, identity.args)).catch((error) => {
						if (
							quoteIdentity === identity &&
							error instanceof ConvexError &&
							errorCode(error) !== 'OUTPUT_PENDING' &&
							!isOperationRecovery(error) &&
							!identity.uncertain
						)
							quoteIdentity = null;
						throw error;
					}),
				attempt.signal
			);
			if (
				!active ||
				attempt.signal.aborted ||
				quoteAttempt !== attempt ||
				session.transportGeneration !== quoteGeneration
			)
				return;
			quoteId = result.id;
			if (quoteIdentity === identity) quoteIdentity = null;
		} catch (error) {
			if (quoteIdentity && !(error instanceof ConvexError)) quoteIdentity.uncertain = true;
			if (active && quoteAttempt === attempt)
				quoteError = saveError(
					error,
					'We couldn’t confirm this push. Click Push to HubSpot again to check the saved result.'
				);
		} finally {
			attempt.abort();
			if (quoteAttempt === attempt) {
				quoteAttempt = null;
				pushingQuote = false;
			}
		}
	}

	let mounted = $state(false);
	const approvalQuery = useQuery(api.contractApprovals.overview, () =>
		mounted && auth.authenticated && !runtime.paused
			? { membershipId, id: contractId, context: 'playbook' as const }
			: 'skip'
	);
	const latestApproval = $derived(approvalQuery.data?.request);
	let notifiedVisible = $state(false);
	let notifiedOpening: unknown;
	let recordedOpening = false;
	let viewerPresentation =
		$state<import('$lib/auth/workspace-presentation.svelte').PresentationOutcome>('pending');
	const exactDisplayReconciled = $derived.by(() => {
		const displayed = viewer.exactDisplay;
		return Boolean(
			stateReconciled &&
			definitionsReady &&
			!persistence.recoveryPending &&
			!persistence.deleted &&
			!source.issue &&
			!workspace.renderer.error &&
			!viewer.preparationBlocked &&
			displayed &&
			displayed.source === source.renderSource &&
			!displayed.previewChanges.length &&
			sameSelection(displayed.concessions, renderChoices)
		);
	});
	const displayedStateReconciled = $derived.by(() => {
		const displayed = viewer.displayedSnapshot;
		return Boolean(
			exactDisplayReconciled &&
			viewer.pagesVisible &&
			viewer.layoutPrepared &&
			displayed &&
			displayed === workspace.renderer.snapshot &&
			displayed.source === source.renderSource &&
			!displayed.previewChanges.length &&
			sameSelection(displayed.concessions, renderChoices)
		);
	});
	$effect(() => {
		const revision = openingRevision;
		if (exactDisplayReconciled && (!notifiedVisible || notifiedOpening !== revision)) {
			notifiedVisible = true;
			notifiedOpening = revision;
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
			(!notifiedVisible || notifiedOpening !== openingRevision) &&
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
	let foreground = $state(false);
	let active = true;
	let checkingDeal: Promise<void> | undefined;
	async function checkDeal() {
		if (!persistence.confirmed.hubspot) return;
		if (checkingDeal) return checkingDeal;
		const current = client
			.action(api.hubspotDeals.check, { membershipId, contractId })
			.then(() => {
				if (active && persistence.workBlock) {
					throw new ConvexError({
						code: persistence.workBlock,
						message: workBlockMessage(persistence.workBlock)
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
			foreground = document.visibilityState === 'visible';
			if (foreground) {
				void checkDeal().catch(() => {});
				if (auth.authenticated && !runtime.paused && connected)
					void client
						.mutation(api.hubspotRecipients.request, { membershipId, contractId })
						.catch(() => {});
			}
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
		quoteAttempt?.abort();
	});
	const stateReconciled = $derived(
		Boolean(
			auth.authenticated &&
			contractEditor.currentReady &&
			!runtime.paused &&
			metadata.data &&
			!metadata.error &&
			persistence.confirmed.stateRevision >= metadata.data.stateRevision
		)
	);
	$effect(() => {
		const link = metadata.data?.hubspot;
		const eligible =
			mounted &&
			foreground &&
			interactionAdmitted &&
			auth.authenticated &&
			!runtime.paused &&
			connected &&
			!metadata.error &&
			!persistence.deleted &&
			Boolean(link);
		untrack(() => {
			if (eligible)
				void client
					.mutation(api.hubspotRecipients.request, { membershipId, contractId })
					.catch(() => {});
		});
	});
	const editable = $derived(
		persistence.editable &&
			contractEditor.currentDocumentReady &&
			displayedStateReconciled &&
			viewer.interactionEnabled
	);
	let resolutionError = $state<string | null>(null);

	async function loadLatest() {
		if (runtime.paused || session.blocked || !stateReconciled) return;
		resolutionError = null;
		if (!(await persistence.useConfirmedState()) && active)
			resolutionError = 'We couldn’t load the latest contract state. Your changes are still here.';
	}
	let animateInspectorContent = $state(false);
	let selectedItemId = $state<string | null>(null),
		selectedAnnotationId = $state<string | null>(null);
	$effect(() => contractEditor.preparePreview(selectedItemId));
	const item = $derived(
		source.items?.find((i) => i._id === selectedItemId && i.origin.kind === 'template')
	);
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
	function toggle(optionId: string | null) {
		if (item && editable) persistence.setOption(item._id, optionId);
	}

	function selectClause(itemId: string, annotationId: string) {
		if (
			!displayedStateReconciled ||
			!viewer.interactionEnabled ||
			!contractItems.some((item) => item._id === itemId)
		)
			return false;
		animateInspectorContent = inspectorVisible && selectedItemId !== itemId;
		contractEditor.prefetchPreview(itemId);
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
		identity: () => approvalQuery.data?.summary.identity,
		tags: () => reviewTags
	});
	onDestroy(() => reviews.destroy());
	let dismissedCompletion = $state<string | null>(null);
	const awaitingCompletion = $derived(reviews.completion);
	const completionGeneration = $derived(
		reviews.completionGeneration === null ? null : `${contractId}:${reviews.completionGeneration}`
	);
	$effect(() => {
		persistence.confirmed;
		isAdmin;
		reviewTags;
		reviews.setLifetime(
			auth.authenticated && !runtime.paused && !session.blocked,
			session.transportGeneration
		);
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
	const reviewPages = new ContractReviewPages({
		client,
		membershipId,
		id: contractId,
		kind: 'playbook',
		autoLoad: true,
		documentId: () => persistence.confirmed.documentId,
		enabled: () =>
			mounted && auth.authenticated && !runtime.paused && !persistence.deleted && !session.blocked,
		generation: () => `${session.transportGeneration}:${isAdmin}`
	});
	onDestroy(() => reviewPages.destroy());
	const reviewTags = $derived.by<ReviewTag[]>(() =>
		reviewPages.rows
			.filter((review) =>
				contractItems.some((item) => item._id === review.key && item.review.kind === 'required')
			)
			.map((review) => ({
				...review,
				admin: isAdmin,
				disabled: !canReview || reviews.deciding || reviews.completionBusy,
				...(reviews.decisionError?.changeId === review.changeId
					? { error: reviews.decisionError.message }
					: {})
			}))
	);
	const reviewGutter = $derived(reviewTags.length ? REVIEW_GUTTER_WIDTH : 0);

	const approvalCount = $derived(
		(approvalQuery.data?.summary.pendingCount ?? 0) +
			(approvalQuery.data?.summary.declinedCount ?? 0)
	);
	const pendingApprovalCount = $derived(approvalQuery.data?.summary.pendingCount ?? 0);
	const rejectedApprovalCount = $derived(approvalQuery.data?.summary.declinedCount ?? 0);

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
		if (!pendingApprovalCount)
			reviewLinkMessage = 'There are no Playbook changes waiting for review.';
		untrack(() => {
			reviews.navigation = {};
		});
	});

	const matchingApproval = $derived(
		latestApproval?.active && approvalQuery.data?.unsubmittedPendingCount === 0
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
		return 'Submit for approval';
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
	const approvalMessage = $derived.by(() => {
		const action = 'creating the first buyer link or preparing this contract for signature';
		if (rejectedApprovalCount > 0) {
			const before = action;
			return rejectedApprovalCount === 1
				? `Your Playbook change was declined. Remove it before ${before}.`
				: `Your Playbook changes were declined. Remove them before ${before}.`;
		}
		if (!approvalSending && approvalRequested)
			return `Approval has been requested. Waiting for approval before ${action}.`;
		return approvalNeeded
			? `${approvalCount === 1 ? 'This Playbook change requires' : 'These Playbook changes require'} approval before ${action}.`
			: null;
	});
	const approvalRetryBlocked = $derived(
		latestApproval &&
			['failed', 'uncertain'].includes(latestApproval.status) &&
			!latestApproval.retryEligible
	);
	$effect(() => {
		persistence.choices;
		persistence.confirmed.title;
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
		if (!stateReconciled || !definitionsReady)
			return 'Waiting for the contract to finish updating.';
		if (navigating.to) return 'Please wait while the next page opens.';
		return null;
	});
	const approvalEligibilityReason = $derived.by(() => {
		if (latestApproval?.status === 'sending') return 'Your approval request is being sent.';
		if (!pendingApprovalCount)
			return rejectedApprovalCount
				? 'The selected changes were declined. Withdraw them or choose other options to request approval again.'
				: 'There are no Playbook changes waiting for approval.';
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
	// New actions prepare the current saved contract; retries retain their original output owner.
	const exportDisabledReason = $derived.by(() => {
		if (persistence.deleted) return 'This contract was deleted.';
		if (persistence.blockedReason) return persistence.blockedReason;
		if (session.blocked || !auth.authenticated) return 'Reconnect to your account to continue.';
		if (!connected) return 'Reconnect to continue.';
		if (runtime.paused || navigating.to) return 'Please wait while the next page opens.';
		if (persistence.conflict || persistence.error)
			return 'Resolve unsaved changes before continuing.';
		if (exportStatus.error) return 'We couldn’t check contract approval. Reload and try again.';
		if (!exportStatus.data) return 'Checking contract approval.';
		if (!persistence.pending && !exportStatus.data.canExport)
			return 'Approve all required changes before preparing this contract for signature.';
		return null;
	});
	const integrationStatusReason = $derived(
		hubspotConnection.error
			? 'We couldn’t check HubSpot integration status. Retry the integration check.'
			: !hubspotConnection.data || hubspotConnection.isLoading
				? 'Checking HubSpot integration status.'
				: null
	);
	const quoteDisabledReason = $derived.by(() => {
		if (integrationStatusReason) return integrationStatusReason;
		if (exportDisabledReason)
			return exportDisabledReason.replace(/downloading/gu, 'pushing to HubSpot');
		if (pushingQuote || quotePending) return 'Your HubSpot quote is being prepared.';
		const connection = hubspotConnection.data!;
		if (!connection.quotes?.connected) return 'Ask an admin to reconnect HubSpot Quotes.';
		if (!connection.enabled || !connection.quotes.enabled || !connection.quotes.pushEnabled)
			return 'Pushing to HubSpot is temporarily unavailable.';
		return null;
	});
	const downloadDisabledReason = $derived(
		integrationStatusReason ??
			(preparingWord ? 'Your Word document is being prepared.' : exportDisabledReason)
	);
	const exportReady = $derived(exportDisabledReason === null);
	const canExport = $derived(downloadDisabledReason === null);
	const mainActionLabel = $derived(quotesInstalled ? 'Push to HubSpot' : 'Download as .docx');
	const mainActionDisabledReason = $derived(
		quotesInstalled ? quoteDisabledReason : downloadDisabledReason
	);
	const canRunMainAction = $derived(mainActionDisabledReason === null);
	const canRequestApproval = $derived(approvalDisabledReason === null);
	const feedback = $derived<OperationStatus | null>(
		persistence.selectionLimitError || resolutionError
			? { message: persistence.selectionLimitError ?? resolutionError!, urgent: true }
			: preparingWord
				? { message: 'Preparing Word download…' }
				: exportError
					? {
							message: exportError,
							urgent: true,
							actions: canExport
								? [
										{
											label: 'Retry download',
											run: () => {
												void downloadSavedWord();
											}
										}
									]
								: []
						}
					: quoteFeedback
	);
	let approvalHintTrigger = $state<HTMLSpanElement>();
	let mainActionHintTrigger = $state<HTMLSpanElement>();

	$effect(() => {
		const generation = session.transportGeneration;
		const ready = exportReady;
		untrack(() => {
			exportError = null;
			if (wordAttempt && ((wordDispatched && !ready) || generation !== wordGeneration)) {
				wordAttempt.abort();
				wordAttempt = null;
			}
			if (quoteAttempt && ((quoteDispatched && !ready) || generation !== quoteGeneration)) {
				quoteAttempt.abort();
				quoteAttempt = null;
				pushingQuote = false;
			}
		});
	});
	let wordDispatched = $state(false);
	let wordGeneration = 0;
	async function downloadSavedWord() {
		if (!active || !canExport) return;
		const attempt = new ReadAttempt(30_000);
		wordGeneration = session.transportGeneration;
		wordAttempt = attempt;
		wordDispatched = false;
		exportError = null;
		try {
			if (!exportIdentity) {
				const expectedSource = await waitForRead(prepareSource(attempt.signal), attempt.signal);
				if (
					!active ||
					attempt.signal.aborted ||
					wordAttempt !== attempt ||
					session.transportGeneration !== wordGeneration
				)
					return;
				exportIdentity = {
					args: {
						membershipId,
						id: contractId,
						expectedSource,
						operationId: createOperationId(),
						claim: crypto.randomUUID()
					}
				};
			}
			const identity = exportIdentity;
			assertOperationRetryable(identity.args.operationId);
			wordDispatched = true;
			attempt.complete();
			const generation = continueOutputAction(
				() =>
					(assertOperationRetryable(identity.args.operationId),
					client.action(api.wordExport.generate, identity.args)).catch((error) => {
						// Observe authoritative retirement even after the foreground waiter is canceled.
						if (
							exportIdentity === identity &&
							error instanceof ConvexError &&
							errorCode(error) !== 'OUTPUT_PENDING' &&
							!isOperationRecovery(error) &&
							!identity.uncertain
						)
							exportIdentity = null;
						throw error;
					}),
				attempt.signal
			);
			const result = await waitForRead(generation, attempt.signal);
			const delivery = new ReadAttempt(30_000, attempt.signal);
			try {
				const response = await fetch(result.url, { signal: delivery.signal, cache: 'no-store' });
				if (!response.ok) throw new Error('Download failed.');
				const blob = await waitForRead(response.blob(), delivery.signal);
				if (
					attempt.signal.aborted ||
					!active ||
					wordAttempt !== attempt ||
					!exportReady ||
					session.transportGeneration !== wordGeneration
				)
					return;
				downloadWord(blob, result.filename);
				journalDownload(membershipId, result.attemptId, Date.now(), result.releasedAt);
				void flushDownloadAcks(client, membershipId);
				if (exportIdentity === identity) exportIdentity = null;
			} finally {
				delivery.abort();
			}
		} catch (error) {
			if (exportIdentity && !(error instanceof ConvexError)) exportIdentity.uncertain = true;
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
	$effect(() =>
		onChrome({
			feedback,
			onDownload: quotesInstalled
				? () => {
						void downloadSavedWord();
					}
				: undefined,
			downloadReason: downloadDisabledReason
		})
	);
	$effect(() =>
		onBindings({
			panelContent,
			footerContent,
			onPresentation: (outcome) => {
				viewerPresentation = outcome;
			},
			failure: definitionsFailed
				? {
						message:
							contractEditor.documentInput.items?.error instanceof Error
								? contractEditor.documentInput.items.error.message
								: 'The approved contract is unavailable.'
					}
				: undefined,
			onRetry: definitionsFailed ? onRetry : undefined,
			hasPanel: inspectorVisible,
			selectedAnnotationId,
			reviewTags,
			reviewGutter,
			reviewNavigation: reviews.navigation,
			onReviewDecision: (tag, status) => void reviews.decide(tag, status),
			selectedConcessions: renderChoices,
			allowPlaybookNavigation: true,
			playbookNavigationReady: displayedStateReconciled && viewer.interactionEnabled,
			onRemoveConcession: (itemId) => {
				if (editable) persistence.setOption(itemId as Id<'playbookItems'>, null);
			},
			panelTarget: item?.primary.target,
			onSelect: selectClause,
			onItemIntent: (itemId) => contractEditor.prefetchPreview(itemId),
			onDocumentBackground: () => close(false)
		})
	);
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
	{#if !persistence.deleted && persistence.workBlock}
		<HeaderContent placement="notice">
			<NoticeBar
				action={{
					label: persistence.workBlock === 'deal-unavailable' ? 'Link another deal' : 'Link a deal',
					'aria-haspopup': 'dialog',
					onclick: () => (repairHubSpot = true)
				}}
			>
				{persistence.blockedReason}
			</NoticeBar>
		</HeaderContent>
	{/if}
	{#if !persistence.deleted && saveNotice && (saveNotice.status === 'Save failed' || (saveNotice.status === 'Paused' && !persistence.workBlock) || saveNotice.memoryOnly)}
		<div
			role="alert"
			class="mx-auto mt-4 max-w-3xl rounded-md border-hairline border-edge bg-surface p-3 text-sm shadow-card"
		>
			{#if saveNotice.status === 'Save failed'}
				<p>{saveNotice.message ?? 'We couldn’t save your changes. Try again.'}</p>
				<button
					type="button"
					class="mt-2 underline disabled:text-ink-muted"
					disabled={session.blocked || persistence.recoveryBlocked}
					onclick={() => contractEditor.retry()}>Retry</button
				>
			{:else if saveNotice.status === 'Paused' && !persistence.workBlock}
				<p>{saveNotice.message ?? 'Saving is paused. Your changes have not been saved yet.'}</p>
			{/if}
			{#if saveNotice.memoryOnly}
				<p class="mt-2">
					Browser storage is unavailable. Keep this tab open until these changes save.
				</p>
			{/if}
		</div>
	{/if}
{/if}
{#if persistence.deleted}<p
		role="alert"
		class="mx-auto mt-4 max-w-3xl rounded-md border-hairline border-edge bg-surface p-3 shadow-card text-sm"
	>
		This contract was deleted. <a class="underline" href="/contracts">Back to Contracts</a>
	</p>
{:else if persistence.conflict || persistence.recoveryBlocked}<div
		role="alert"
		class="mx-auto mt-4 max-w-3xl rounded-md border-hairline border-edge bg-surface p-3 shadow-card text-sm"
	>
		{persistence.recoveryBlocked
			? 'This request can no longer be retried. Review your selections against the current saved contract before applying them as a new request.'
			: 'This contract changed elsewhere. Choose which selections to keep.'}
		<button
			class="ml-2 underline disabled:text-ink-muted"
			disabled={session.blocked || !stateReconciled}
			onclick={() => {
				if (contractEditor.journal.recoveryError) contractEditor.discard();
				else void loadLatest();
			}}>Use saved selections</button
		>
		<button
			class="ml-2 underline disabled:text-ink-muted"
			disabled={session.blocked ||
				!stateReconciled ||
				Boolean(contractEditor.journal.recoveryError)}
			onclick={() => {
				if (!session.blocked && stateReconciled && !contractEditor.journal.recoveryError)
					persistence.applyRecovered();
			}}>{persistence.recoveryBlocked ? 'Apply as new selections' : 'Apply my selections'}</button
		>
		{#if persistence.recoveryBlocked}<button
				class="ml-2 underline"
				onclick={() => contractEditor.journal.downloadRecovery()}>Save stored selections</button
			>{/if}
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
{#snippet panelContent()}{#if item}<RepPlaybookPanel
			{item}
			animateContent={animateInspectorContent}
			{isAdmin}
			selected={persistence.choices[item._id]}
			disabled={!editable}
			entry={persistence.confirmed.playbook.find((state) => state.itemId === item._id)}
			intent={persistence.intent[item._id]}
			preview={contractEditor.focusedPreview}
			previewBusy={contractEditor.previewBusy}
			previewError={contractEditor.previewError?.message}
			onPrefetch={() => contractEditor.prefetchPreview(item._id)}
			onWithdraw={() => persistence.withdraw(item._id)}
			onApprove={reviewTags.find(
				(tag) =>
					tag.changeId ===
					persistence.confirmed.playbook.find((state) => state.itemId === item._id)?.currentChangeId
			)?.approve.allowed === true
				? () => {
						const tag = reviewTags.find(
							(tag) =>
								tag.changeId ===
								persistence.confirmed.playbook.find((state) => state.itemId === item._id)
									?.currentChangeId
						);
						if (tag) void reviews.decide(tag, 'approve');
					}
				: undefined}
			onToggle={toggle}
			onClose={() => close()}
		/>{/if}{/snippet}
{#snippet footerContent()}
	{#if reviewPages.error}<p class="mt-3 text-center text-sm text-danger" role="alert">
			{reviewPages.error}
			<button class="underline" onclick={() => reviewPages.reset()}>Retry reviews</button>
		</p>{/if}
	{#if reviewPages.detailError}<p class="mt-3 text-center text-sm text-danger" role="alert">
			{reviewPages.detailError}
			<button class="underline" onclick={() => reviewPages.retryDetails()}
				>Retry review checks</button
			>
		</p>{/if}
	{#if !reviewPages.done}<p class="mt-3 text-center text-sm text-ink-muted">
			<button
				class="underline disabled:no-underline"
				disabled={reviewPages.loading}
				onclick={() => reviewPages.loadMore()}
				>{reviewPages.loading ? 'Loading reviews…' : 'Load more review tags'}</button
			>
		</p>{/if}
	<div
		class="pt-6"
		role="group"
		aria-label="Contract actions"
		aria-busy={preparingWord ||
			approvalSending ||
			(quotesInstalled && (pushingQuote || quotePending))}
	>
		<div class="flex flex-wrap items-center justify-center gap-3">
			<Tooltip
				text={approvalDisabledReason ?? ''}
				trigger={approvalHintTrigger}
				standalone={false}
				enabled={!canRequestApproval}
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
				text={mainActionDisabledReason ?? ''}
				trigger={mainActionHintTrigger}
				standalone={false}
				enabled={!canRunMainAction}
			>
				{#snippet children(descriptionId)}
					<!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users focus this wrapper to read why the native disabled button is unavailable.) -->
					<span
						bind:this={mainActionHintTrigger}
						class="inline-flex rounded-button-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
						role="group"
						tabindex={!canRunMainAction ? 0 : undefined}
						aria-label={mainActionLabel}
						aria-describedby={!canRunMainAction ? descriptionId : undefined}
					>
						<Button
							class="bg-accent text-white not-disabled:not-aria-disabled:hover:bg-accent-hover h-11 px-5 text-sm disabled:pointer-events-none"
							disabled={!canRunMainAction}
							aria-describedby={!canRunMainAction ? descriptionId : undefined}
							onclick={() => {
								if (quotesInstalled) void pushQuote();
								else void downloadSavedWord();
							}}
						>
							{mainActionLabel}
						</Button>
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

		{#if reviews.decisionError}<p class="mt-3 text-center text-sm text-ink-muted" role="alert">
				{reviews.decisionError.message}
			</p>{/if}
		{#if preparingWord}
			<p class="mt-3 text-center text-sm text-ink-muted" role="status">Preparing Word download…</p>
		{:else if exportError}
			<p class="mt-3 text-center text-sm text-ink-muted" role="alert">{exportError}</p>
		{/if}
	</div>
{/snippet}

{#if awaitingCompletion && completionGeneration !== dismissedCompletion && !runtime.paused && !session.blocked && !navigating.to && !persistence.deleted}
	{#key completionGeneration}
		<ReviewCompletedModal
			busy={reviews.completionBusy}
			disabled={!canReview || reviews.deciding}
			error={reviews.completionError}
			onSend={() => void reviews.resolveCompletion()}
			onClose={() => (dismissedCompletion = completionGeneration)}
		/>
	{/key}
{/if}

<BuyerLinkBarAdmission
	id={contractId}
	visit={buyerLinkVisit}
	latest={latestBuyerLink}
	{workspace}
	available={buyerLinkAvailable}
	{interactionAdmitted}
/>
