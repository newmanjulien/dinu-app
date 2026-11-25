<script lang="ts">
	import { onDestroy, onMount, tick, untrack, type Snippet } from 'svelte';
	import { navigating, page } from '$app/state';
	import { useConvexClient } from 'convex-svelte';
	import { api } from '../../convex/_generated/api';
	import AppHeader from '$lib/components/chrome/AppHeader.svelte';
	import NoticeBar from '$lib/components/chrome/NoticeBar.svelte';
	import CsmSetupCallBar from '$lib/components/chrome/CsmSetupCallBar.svelte';
	import { useSetupCallRefresh } from '$lib/components/chrome/csm-setup-call.svelte';
	import WorkspaceSaveStatus from '$lib/components/chrome/WorkspaceSaveStatus.svelte';
	import AppStatus from '$lib/components/chrome/AppStatus.svelte';
	import WorkspaceStatus from '$lib/components/chrome/WorkspaceStatus.svelte';
	import { setBuyerLinkCopyFeedback } from '$lib/buyer/copy-feedback.svelte';
	import { setIntegrationFeedback } from '$lib/integration-feedback.svelte';
	import { useHubSpotDeals } from '$lib/hubspot-deals.svelte';
	import { getWorkspaceFeedback } from '$lib/components/chrome/workspace-feedback.svelte';
	import { getTemplateAuthoringSession } from '$lib/playbook/template-authoring-session.svelte';
	import { setHeaderContent } from '$lib/components/chrome/header-content.svelte';
	import { InteractionController, setInteractionController } from '$lib/components/ui/interactions';
	import { setWorkspacePresentation } from './workspace-presentation.svelte';
	import { afterStartupPaint } from './startup-perf';
	import { loadComponent } from './component-loader.svelte';
	import { useViewer, useViewerSession } from './viewer-session.svelte';
	import { supportSection } from '$lib/components/chrome/csm-support';
	import { setCompanySetup } from '$lib/features/company-setup/company-setup.svelte';
	import { VIDEO_ORIGIN, setVideoPreconnect } from '$lib/ui/video.svelte';
	let { children }: { children: Snippet } = $props();
	const videoPreconnect = setVideoPreconnect();
	const header = setHeaderContent();
	const feedback = getWorkspaceFeedback();
	const copies = setBuyerLinkCopyFeedback();
	const integrations = setIntegrationFeedback();
	const authoring = getTemplateAuthoringSession('rep');
	const buyerAuthoring = getTemplateAuthoringSession('buyer');
	let completionNotice = $state<string | null>(null);
	let completionTimer: ReturnType<typeof setTimeout> | undefined;
	let previousRepCompletion = authoring.completion;
	let previousBuyerCompletion = buyerAuthoring.completion;
	$effect(() => {
		const rep = authoring.completion;
		const buyer = buyerAuthoring.completion;
		if (rep === previousRepCompletion && buyer === previousBuyerCompletion) return;
		const changed =
			buyer && buyer !== previousBuyerCompletion
				? { audience: 'buyer' as const, kind: buyer.kind }
				: rep && rep !== previousRepCompletion
					? { audience: 'rep' as const, kind: rep.kind }
					: null;
		previousRepCompletion = rep;
		previousBuyerCompletion = buyer;
		clearTimeout(completionTimer);
		completionNotice = changed
			? changed.kind === 'deleted'
				? changed.audience === 'buyer'
					? 'Explanation deleted'
					: 'Instructions deleted'
				: changed.audience === 'buyer'
					? 'Explanation saved'
					: 'Instructions saved'
			: null;
		if (completionNotice) completionTimer = setTimeout(() => (completionNotice = null), 2500);
	});
	const saveAttention = $derived(
		Boolean(feedback.attention.length || authoring.needsAttention || buyerAuthoring.needsAttention)
	);
	const saveCompletion = $derived(Boolean(completionNotice && !saveAttention));
	const statusNotice = $derived(
		copies.notice
			? { message: copies.notice.message, urgent: copies.notice.kind === 'error' }
			: integrations.confirmation
				? { message: integrations.confirmation.message }
				: null
	);
	const hubspot = useHubSpotDeals().connection;
	const confirmationAnnouncements = $derived(
		copies.notice || integrations.confirmation ? [copies.notice, integrations.confirmation] : null
	);
	$effect(() => {
		integrations.observe(hubspot.error || hubspot.isLoading ? undefined : hubspot.data);
	});
	onDestroy(() => {
		clearTimeout(completionTimer);
		copies.destroy();
		integrations.destroy();
	});
	const client = useConvexClient();
	const viewer = useViewer();
	const session = useViewerSession();
	const csmAccess = $derived(
		viewer().permissions.manageTemplate &&
			!session.blocked &&
			!session.closing &&
			!viewer().company.deletion
	);
	const setupPending = $derived(csmAccess && !viewer().templateReady);
	const supportAvailable = $derived(csmAccess && viewer().templateReady);
	const section = $derived(supportAvailable ? supportSection(page.route.id) : undefined);
	useSetupCallRefresh(() => setupPending);
	const generation = $derived(`${session.preparedSessionId}:${session.transportGeneration}`);
	const presentation = setWorkspacePresentation(
		() => JSON.stringify([page.route.id, page.url.pathname, page.url.search, generation]),
		() => Boolean(navigating.to)
	);
	$effect(() => {
		const ticket = presentation.current;
		if (navigating.to || !presentation.isCurrent(ticket) || ticket.outcome === 'pending') return;
		let cancelled = false;
		let cancelPaint: (() => void) | undefined;
		void tick().then(() => {
			if (cancelled) return;
			cancelPaint = afterStartupPaint(() => {
				if (!cancelled && !navigating.to && presentation.isCurrent(ticket))
					presentation.painted = ticket;
			});
		});
		return () => {
			cancelled = true;
			cancelPaint?.();
			// A cancelled navigation can reuse the current outcome after another paint.
			if (untrack(() => presentation.painted) === ticket) presentation.painted = undefined;
		};
	});
	const setup = setCompanySetup();
	const supportIdentity = $derived(
		supportAvailable && session.preparedSessionId
			? JSON.stringify([
					session.preparedSessionId,
					session.transportGeneration,
					viewer().profile.id,
					viewer().membership.id,
					viewer().company.id
				])
			: undefined
	);
	const widget = loadComponent(
		() => import('$lib/components/chrome/CsmWidget.svelte'),
		() => Boolean(supportIdentity && section) && presentation.canStart(),
		() => presentation.painted
	);
	const CsmWidget = $derived(widget.component);
	let mountedSupportIdentity = $state<string>();
	$effect(() => {
		if (!supportIdentity) mountedSupportIdentity = undefined;
		else if (CsmWidget && section && presentation.canStart())
			mountedSupportIdentity = supportIdentity;
	});
	const interactions = setInteractionController(new InteractionController());
	onMount(() => interactions.mount());
</script>

<svelte:head>
	{#if videoPreconnect.active}
		<link rel="preconnect" href={VIDEO_ORIGIN} />
	{/if}
</svelte:head>

<AppHeader>
	{#snippet notice()}
		{@const hold = viewer().company.deletion}
		{#if hold && hold.status !== 'inProgress'}
			{@const canResolve = hold.status === 'deleting' && hold.ownedByViewer}
			<NoticeBar
				action={canResolve && page.url.pathname !== '/settings'
					? { label: 'Open Settings', href: '/settings' }
					: undefined}
			>
				{#if canResolve}
					Company activity is paused while account deletion finishes. Retry or cancel deletion in
					Settings.
				{:else}
					This company is being deleted and workspace activity is paused.
				{/if}
			</NoticeBar>
		{/if}
		{#if setupPending}
			<CsmSetupCallBar call={viewer().company.setupCall} />
		{/if}
		{#if header.notice}{@render header.notice()}{/if}
	{/snippet}
	<WorkspaceStatus announcement={confirmationAnnouncements}>
		{#if header.content}{@render header.content()}{/if}
		<div
			class={`flex w-fit max-w-[min(640px,calc(100vw-32px))] flex-col gap-2 max-[999px]:w-full ${header.content ? 'ml-auto max-w-[calc(100vw-486px)] max-[999px]:max-w-none' : ''}`}
		>
			<AppStatus
				notice={statusNotice}
				{saveAttention}
				{saveCompletion}
				feedback={feedback.document?.feedback}
				renderError={feedback.document?.renderError}
				sourceStale={feedback.document?.sourceStale}
				onRetryRender={feedback.document?.onRetryRender}
			>
				{#snippet saveFeedback()}<WorkspaceSaveStatus {completionNotice} />{/snippet}
			</AppStatus>
		</div>
	</WorkspaceStatus>
</AppHeader>
{@render children()}
{#if CsmWidget && supportIdentity && (mountedSupportIdentity === supportIdentity || (section && presentation.canStart()))}
	{#key supportIdentity}
		<CsmWidget
			membershipId={viewer().membership.id}
			{section}
			setupComplete={setup.complete}
			collapsed={viewer().membership.supportWidgetCollapsed}
			onCollapsedChange={(collapsed) =>
				client.mutation(api.memberships.setSupportWidgetCollapsed, {
					membershipId: viewer().membership.id,
					collapsed
				})}
			canStart={() => Boolean(supportIdentity && section) && presentation.canStart()}
		/>
	{/key}
{/if}
