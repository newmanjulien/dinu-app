<script lang="ts">
	import { isRepItem } from '$lib/playbook/model';
	import { useReadQuery } from '$lib/auth/read-query.svelte';
	import { DiscussionSession } from '$lib/discussions/session.svelte';
	import { PublicationWarning } from '$lib/contract/publication-warning.svelte';
	import PublicationWarningModal from '$lib/contract/PublicationWarningModal.svelte';

	import { useAccountContext } from '$lib/auth/account-context.svelte';
	import { useHubSpotDeals } from '$lib/hubspot-deals.svelte';
	import { HubSpotRecipient } from '$lib/hubspot-recipient.svelte';
	import BuyerLinkBar from '$lib/buyer/BuyerLinkBar.svelte';
	import { ConvexError } from 'convex/values';
	import { errorCode, workBlockMessage } from '$lib/contract/work-policy';
	import HubSpotRelink from './HubSpotRelink.svelte';
	import { journalDownload, flushDownloadAcks } from '$lib/contract/download-journal';
	let repairHubSpot = $state(false);
	let exportIdentity: { operationId: string; revision: number } | null = null;
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { ContractReviewController } from '$lib/contract/review-controller.svelte';
	import { composeExport } from '$lib/document/export/content';
	import { quoteSemanticIdentity } from '$lib/document/export/quote-identity';
	import { concessionSelections } from '$lib/contract/applications';
	import { toDocumentOverlay } from '$lib/playbook/document-overlay';
	import { documentAnnotations } from '$lib/playbook/document-overlay';
	import { onDestroy, onMount, untrack } from 'svelte';
	import { navigating, page } from '$app/state';
	import { useConvexClient, useQuery } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import type { Id } from '../../../convex/_generated/dataModel';
	import type { TemplateContent } from '$lib/template/model';
	import type { ContractEditor } from '$lib/contract/editors.svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { getContractOpenings } from '$lib/contract/snapshot-cache';
	import type { OperationStatus } from '$lib/components/chrome/operation-status';
	import { createDocumentWorkspace } from '$lib/document/runtime/workspace-factory';
	import { setDocumentWorkspace } from '$lib/document/runtime/workspace-context';
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
	import { recordDocumentInput } from '$lib/document/runtime/render-perf';
	import { setInteractionOwner } from '$lib/components/ui/interactions';
	import InteractionInputScope from '$lib/components/ui/InteractionInputScope.svelte';
	import { sameSelection } from '$lib/playbook/model';
	import { downloadWord } from '$lib/document/export/download';
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
		onFailure,
		openingRevision
	}: {
		snapshot: TemplateContent;
		editor: ContractEditor;
		interactionAdmitted?: boolean;
		onVisible?: () => void;
		openingRevision?: unknown;
		onFailure?: () => void;
	} = $props();
	const initialContract = untrack(() => contractEditor.metadata!);
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
	const workspace = setDocumentWorkspace(
		resource?.workspace ??
			untrack(() =>
				createDocumentWorkspace({
					kind: 'records',
					blocks: { data: snapshot.blocks },
					items: { data: snapshot.items.filter(isRepItem) }
				})
			)
	);

	const { source, viewer } = workspace;
	const client = useConvexClient();
	const auth = useAccountContext()!;
	const session = useViewerSession();
	const accountViewer = useViewer();
	const membershipId = accountViewer().membership.id;
	const contractId = untrack(() => initialContract._id);
	const localDefinitions = useReadQuery(api.contractDefinitions.selected, {
		membershipId,
		id: contractId
	});
	const definitionsReady = $derived.by(() => {
		const selected = persistence.choices;
		const locals = Object.entries(selected).filter(
			([id]) => !snapshot.items.some((item) => item._id === id)
		);
		if (!locals.length) return true;
		return (
			!localDefinitions.error &&
			locals.every(([id, concessionId]) =>
				retainedDefinitions.some(
					(item) => item._id === id && item.concessions.some((c) => c.id === concessionId)
				)
			)
		);
	});
	let retainedDefinitions = $state.raw<NonNullable<typeof localDefinitions.data>>([]);
	$effect(() => {
		const data = localDefinitions.data,
			rejected = localDefinitions.rejected;
		untrack(() => {
			if (rejected) retainedDefinitions = [];
			else if (data) {
				const records = [
					...new Map([...data, ...retainedDefinitions].map((item) => [item._id, item])).values()
				];
				let bytes = 0;
				const encoder = new TextEncoder();
				retainedDefinitions = records
					.filter((item) => {
						const size = encoder.encode(JSON.stringify(item)).byteLength;
						if (bytes + size > 2_000_000) return false;
						bytes += size;
						return true;
					})
					.slice(0, 1024);
			}
		});
	});
	const contractItems = $derived([...snapshot.items.filter(isRepItem), ...retainedDefinitions]);
	$effect(() => {
		const items = contractItems,
			ready = definitionsReady,
			readError = definitionsReady ? undefined : localDefinitions.error;
		untrack(() => {
			source.accept({
				kind: 'records',
				contract: true,
				blocks: { data: snapshot.blocks },
				items: {
					data: ready ? items : undefined,
					error:
						readError ??
						(localDefinitions.data && !definitionsReady
							? new Error('Selected custom wording is unavailable.')
							: undefined)
				}
			});
			if (ready)
				persistence.setRequired(
					new Set(items.filter((i) => i.approvalPolicy.kind === 'required').map((i) => i._id))
				);
		});
	});
	const discussions = new DiscussionSession(
		client,
		{ membershipId, id: contractId },
		() => persistence.confirmed.editRevision
	);
	$effect(() =>
		discussions.setActive(
			active && interactionAdmitted && definitionsReady && !runtime.paused && !session.blocked
		)
	);
	onDestroy(() => discussions.destroy());
	const hubspot = useHubSpotDeals();
	const hubspotConnection = hubspot.connection;
	const quotesInstalled = $derived(Boolean(hubspotConnection.data?.quotes?.installed));
	let quoteId = $state<Id<'hubspotQuotePushes'>>();
	let pushingQuote = $state(false);
	let quoteError = $state<string | null>(null);
	let quoteIdentity: { operationId: string; revision: number; canonicalKey: string } | null = null;
	// Only saved semantic inputs invalidate this composition, never quote settlements/approval feedback.
	const quoteSelections = $derived(
		JSON.stringify(concessionSelections(persistence.confirmed.applications))
	);
	const quoteTitle = $derived(persistence.confirmed.buyerCompanyName);
	const quoteAccount = $derived(persistence.confirmed.hubspot?.accountId);
	const quoteDeal = $derived(persistence.confirmed.hubspot?.dealId);
	const quoteVersion = $derived(metadata.data?.templateVersionId);
	const savedQuoteKey = $derived.by(() => {
		if (
			!quotesInstalled ||
			!quoteAccount ||
			!quoteDeal ||
			quoteVersion !== initialContract.templateVersionId ||
			snapshot.blocks.length !== snapshot.blockCount ||
			snapshot.items.length !== snapshot.itemCount
		)
			return null;
		try {
			const selected: Record<string, string> = JSON.parse(quoteSelections);
			const byId = new Map(contractItems.map((item) => [String(item._id), item]));
			const items = Object.entries(selected).map(([id, concessionId]) => {
				const item = byId.get(id);
				if (!item?.concessions.some((concession) => concession.id === concessionId))
					throw new Error('Selected historical concession is unavailable');
				return toDocumentOverlay(item);
			});
			return quoteSemanticIdentity(
				{
					companyId: initialContract.companyId,
					contractId,
					accountId: quoteAccount,
					dealId: quoteDeal,
					title: quoteTitle
				},
				composeExport({ blocks: snapshot.blocks, items, activeConcessions: selected })
			).canonicalKey;
		} catch {
			return null;
		}
	});
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
					? `${savedQuoteKey !== null && quote.canonicalKey === savedQuoteKey ? 'Contract pushed.' : 'A previous contract version was pushed.'} Review the draft and complete pricing, recipients and sending in HubSpot.`
					: (quote.message ?? 'Review this quote in HubSpot.'),
			urgent: ['unknown', 'attention', 'rejected'].includes(quote.state),
			actions
		};
	});
	async function pushQuote() {
		if (!active || quoteDisabledReason || !savedQuoteKey) return;
		const revision = persistence.confirmed.editRevision;
		const canonicalKey = savedQuoteKey;
		const identity =
			quoteIdentity?.revision === revision && quoteIdentity.canonicalKey === canonicalKey
				? quoteIdentity
				: (quoteIdentity = { operationId: crypto.randomUUID(), revision, canonicalKey });
		pushingQuote = true;
		quoteError = null;
		exportError = null;
		try {
			await checkDeal();
			if (
				!active ||
				persistence.confirmed.editRevision !== revision ||
				savedQuoteKey !== canonicalKey
			)
				return;
			const result = await client.action(api.hubspotQuoteActions.push, {
				membershipId,
				id: contractId,
				expectedEditRevision: revision,
				operationId: identity.operationId,
				expectedCanonicalKey: canonicalKey
			});
			if (active) quoteId = result.id;
		} catch (error) {
			if (active)
				quoteError = saveError(
					error,
					'We couldn’t confirm this push. Click Push to HubSpot again to check the saved result.'
				);
		} finally {
			pushingQuote = false;
		}
	}

	let mounted = $state(false);
	const approvalQuery = useQuery(api.contractApprovals.latest, () =>
		mounted && auth.authenticated && !runtime.paused ? { membershipId, id: contractId } : 'skip'
	);
	const latestApproval = $derived(approvalQuery.data);
	$effect(() => attachment?.update(persistence.choices));
	let notifiedVisible = $state(false);
	let notifiedOpening: unknown;
	$effect(() => {
		const revision = openingRevision;
		if (
			notifiedVisible &&
			auth.authenticated &&
			displayedStateReconciled &&
			notifiedOpening !== revision
		) {
			notifiedOpening = revision;
			untrack(() => onVisible?.());
		}
	});
	let recordedOpening = false;
	let viewerPresentation =
		$state<import('$lib/auth/workspace-presentation.svelte').PresentationOutcome>('pending');
	const displayedStateReconciled = $derived.by(() => {
		const displayed = viewer.displayedSnapshot;
		return Boolean(
			stateReconciled &&
			definitionsReady &&
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
			notifiedOpening = openingRevision;
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
				void recipient.refresh();
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
	});
	const stateReconciled = $derived(
		Boolean(
			auth.authenticated &&
			!runtime.paused &&
			metadata.data &&
			!metadata.error &&
			persistence.confirmed.stateVersion >= metadata.data.stateVersion
		)
	);
	const recipientOwner = $derived.by(() => {
		const identity = hubspot.identity;
		const connection = hubspotConnection.data;
		const link = persistence.confirmed.hubspot;
		if (
			!mounted ||
			!interactionAdmitted ||
			!auth.authenticated ||
			runtime.paused ||
			!connected ||
			metadata.error ||
			persistence.deleted ||
			!identity ||
			!connection?.companyReadGranted ||
			!link ||
			link.availability !== 'available' ||
			link.connectionId !== connection.connectionId ||
			link.accountId !== connection.accountId ||
			connection.installedAt === null
		)
			return null;
		const target = {
			connectionId: link.connectionId,
			accountId: link.accountId,
			dealId: link.dealId,
			generation: link.generation,
			installedAt: connection.installedAt
		};
		return {
			key: JSON.stringify([
				identity,
				contractId,
				target.connectionId,
				target.accountId,
				target.dealId,
				target.generation,
				target.installedAt
			]),
			target
		};
	});
	const recipient = new HubSpotRecipient({
		client,
		membershipId,
		contractId,
		owner: () => recipientOwner
	});
	const recipientIdentity = $derived(recipientOwner?.key ?? null);
	$effect(() => {
		const owner = recipientIdentity;
		const visible = foreground;
		untrack(() => {
			recipient.align(owner);
			if (visible) void recipient.refresh();
		});
	});
	onDestroy(() => recipient.destroy());
	const editable = $derived(
		persistence.editable && stateReconciled && definitionsReady && notifiedVisible
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
	async function toggle(id: string) {
		if (!item || !editable) return;
		if (persistence.choices[item._id] !== id && reasons[id]) return;
		const chosen = item;
		const apply = async () => {
			if (!editable || source.items?.find((i) => i._id === chosen._id) !== chosen) return;
			persistence.select(chosen._id, id);
		};
		if (
			isAdmin &&
			item.approvalPolicy.kind === 'required' &&
			persistence.choices[item._id] !== id
		) {
			try {
				await publicationWarning.run('Continue and apply', apply);
			} catch (error) {
				resolutionError = saveError(error, 'We couldn’t apply this change. Try again.');
			}
		} else await apply();
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
	const publicationWarning = new PublicationWarning(client, membershipId, contractId);
	const publicationStatus = useReadQuery(api.buyerLinks.warning, { membershipId, id: contractId });
	onDestroy(() => publicationWarning.destroy());
	const reviews: ContractReviewController = new ContractReviewController({
		client,
		membershipId,
		contractId,
		persistence,
		isAdmin: () => isAdmin,
		canReview: () => canReview,
		publicationWarning,
		preflight: checkDeal,
		canRequest: () => approvalEligibilityReason === null,
		tags: () => reviewTags
	});
	discussions.onApply = async (thread) => {
		await checkDeal();
		if (
			!editable ||
			!(await contractEditor.savePending()) ||
			persistence.pending ||
			persistence.conflict
		)
			throw new Error('Save or resolve pending changes before applying this proposal.');
		const args = {
			membershipId,
			id: contractId,
			threadId: thread.id,
			expectedMessageRevision: thread.root.revision,
			expectedEditRevision: persistence.confirmed.editRevision,
			operationId: crypto.randomUUID()
		};
		const apply = async () => {
			await client.mutation(api.discussionProposals.apply, args);
		};
		if (isAdmin) await publicationWarning.run('Continue and apply', apply);
		else await apply();
	};
	$effect(() => {
		if (persistence.publicationConfirmationRequired && !publicationWarning.pending)
			untrack(() => {
				persistence.publicationConfirmationRequired = false;
				publicationWarning.request('Continue and apply', async () => {
					persistence.retry();
					if (!(await persistence.savePending()))
						throw new Error(
							persistence.error ?? 'This contract changed. Review the current wording.'
						);
				});
			});
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
		selectedReviewApplications(contractItems, persistence.choices)
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
	const savedReviewTags = $derived(savedReviews(contractItems, persistence.confirmed));
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
	const approvalMessage = $derived.by(() => {
		const action = quotesInstalled ? 'pushing to HubSpot' : 'download';
		if (rejectedApprovalCount > 0) {
			const before = quotesInstalled ? action : 'downloading';
			return rejectedApprovalCount === 1
				? `Your concession was declined. Remove it before ${before}.`
				: `Your concessions were declined. Remove them before ${before}.`;
		}
		if (!approvalSending && approvalRequested)
			return `Approval has been requested. Waiting for approval before ${action}.`;
		return approvalNeeded
			? `${approvalCount === 1 ? 'This concession requires' : 'These concessions require'} approval before ${action}.`
			: null;
	});
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
		if (!stateReconciled || !definitionsReady)
			return 'Waiting for the contract to finish updating.';
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
	const integrationStatusReason = $derived(
		!hubspotConnection.data || hubspotConnection.error
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
		if (!savedQuoteKey)
			return 'The saved contract could not be prepared for HubSpot. Reload and try again.';
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
	<WorkspaceChrome
		settingsHref={`/contracts/${contractId}/settings`}
		{feedback}
		helpVariant="rep"
		helpReady={notifiedVisible}
		onDownload={quotesInstalled
			? () => {
					void downloadSavedWord();
				}
			: undefined}
		downloadReason={downloadDisabledReason}
	/>
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
					>{persistence.workBlock === 'deal-unavailable'
						? 'Link another deal'
						: 'Link a deal'}</Button
				>
			</div>
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
					disabled={session.blocked}
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
			if (event.type === 'click') recordDocumentInput(event);
		}}
	>
		<main
			class="pt-14 pb-[calc(64px+var(--buyer-link-bar-height,0px))] [--workspace-loading-inset:calc(var(--spacing)*30)] min-[1000px]:pt-6 min-[1000px]:[--workspace-loading-inset:calc(var(--spacing)*22)]"
			onclickcapture={recordDocumentInput}
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
							text={mainActionDisabledReason ?? ''}
							trigger={mainActionHintTrigger}
							standalone={false}
							enabled={!canRunMainAction}
							class="rounded-md border-hairline border-edge bg-surface px-2 py-1 text-left text-xs leading-[1.4] text-ink shadow-floating"
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
					{discussions}
					{attachment}
					entry={resource}
					active={!runtime.paused}
					onPresentation={(outcome) => (viewerPresentation = outcome)}
					prepare={!runtime.paused && definitionsReady}
					failure={!definitionsReady && source.issue
						? { message: 'Selected custom wording is unavailable.' }
						: undefined}
					onRetry={!definitionsReady ? () => localDefinitions.retry() : undefined}
					interactive={interactionAdmitted &&
						stateReconciled &&
						definitionsReady &&
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
			publishedBuyer={publicationStatus.data?.published ? contractEditor.name : null}
			busy={reviews.completionBusy}
			disabled={!canReview || reviews.deciding}
			error={reviews.completionError}
			onSend={() => void reviews.resolveCompletion(false)}
			onReset={() => void reviews.resolveCompletion(true)}
			onClose={() => (dismissedCompletion = completionGeneration)}
		/>
	{/key}
{/if}

{#if interactionAdmitted && !runtime.paused && !persistence.deleted && !persistence.workBlock}<BuyerLinkBar
		id={contractId}
		recipientName={persistence.confirmed.hubspot
			? (recipient.name ?? 'the customer')
			: contractEditor.name}
	/>{/if}

{#if !runtime.paused && !session.blocked}<PublicationWarningModal
		warning={publicationWarning}
		buyer={contractEditor.name}
	/>{/if}
