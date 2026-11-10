<script lang="ts">
	import { onDestroy, onMount, tick, untrack, type Snippet } from 'svelte';
	import { navigating, page } from '$app/state';
	import AppHeader from '$lib/components/chrome/AppHeader.svelte';
	import WorkspaceSaveStatus from '$lib/components/chrome/WorkspaceSaveStatus.svelte';
	import AppStatus from '$lib/components/chrome/AppStatus.svelte';
	import WorkspaceStatus from '$lib/components/chrome/WorkspaceStatus.svelte';
	import CopyConfirmation from '$lib/buyer/CopyConfirmation.svelte';
	import { setBuyerLinkCopyFeedback } from '$lib/buyer/copy-feedback.svelte';
	import { setIntegrationFeedback } from '$lib/integration-feedback.svelte';
	import { useHubSpotDeals } from '$lib/hubspot-deals.svelte';
	import StatusBubble from '$lib/components/chrome/StatusBubble.svelte';
	import { getWorkspaceFeedback } from '$lib/components/chrome/workspace-feedback.svelte';
	import { setHeaderContent } from '$lib/components/chrome/header-content.svelte';
	import { InteractionController, setInteractionController } from '$lib/components/ui/interactions';
	import { setWorkspacePresentation } from './workspace-presentation.svelte';
	import { afterStartupPaint } from './startup-perf';
	import { loadComponent } from './component-loader.svelte';
	import { useViewer, useViewerSession } from './viewer-session.svelte';
	import { describeRoute } from './routes';
	import { setCsmPreload } from '$lib/components/chrome/csm-preload.svelte';
	import { setCsmDialog } from '$lib/components/chrome/csm-dialog.svelte';
	import CsmDialogHost from '$lib/components/chrome/CsmDialogHost.svelte';
	import { supportSection, supportContent } from '$lib/components/chrome/csm-support';
	import { setCompanySetup } from '$lib/features/company-setup/company-setup.svelte';
	let { children }: { children: Snippet } = $props();
	const header = setHeaderContent();
	const feedback = getWorkspaceFeedback();
	const copies = setBuyerLinkCopyFeedback();
	const integrations = setIntegrationFeedback();
	const hubspot = useHubSpotDeals().connection;
	const confirmationAnnouncements = $derived(
		copies.confirmation || integrations.confirmation
			? [copies.confirmation, integrations.confirmation]
			: null
	);
	$effect(() => {
		integrations.observe(hubspot.error || hubspot.isLoading ? undefined : hubspot.data);
	});
	onDestroy(() => {
		copies.destroy();
		integrations.destroy();
	});
	const viewer = useViewer();
	const session = useViewerSession();
	const section = $derived(supportSection(page.route.id, viewer().templateReady));
	const supportAvailable = $derived(
		viewer().membership.role === 'admin' &&
			!session.blocked &&
			!session.closing &&
			!viewer().company.deletionPending
	);
	const setupAvailable = $derived(
		supportAvailable &&
			describeRoute(page.route.id).document === 'template' &&
			viewer().templateReady
	);
	// This fact belongs to the membership, beyond a launcher or connection lifetime.
	let optimisticSetupBooked = $state(false);
	const setupBooked = $derived(viewer().company.csmCallBooked || optimisticSetupBooked);
	const eligible = $derived(supportAvailable && !!section);
	const generation = $derived(`${session.preparedSessionId}:${session.transportGeneration}`);
	const presentation = setWorkspacePresentation(
		() =>
			JSON.stringify([
				page.route.id,
				page.url.pathname,
				page.url.search,
				generation,
				describeRoute(page.route.id).requiresTemplate ? viewer().templateReady : null
			]),
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
	const setup = setCompanySetup(() => presentation.canStart());
	const support = $derived(eligible && section ? { section, complete: setup.complete } : undefined);
	const preload = setCsmPreload(
		() => eligible && presentation.canStart(),
		() => setupBooked
	);
	$effect(() => {
		preload.align();
	});
	const dialog = setCsmDialog(
		() => eligible && presentation.canStart(),
		() => setupAvailable,
		() => (optimisticSetupBooked = true),
		() => support
	);
	$effect(() => {
		dialog.align();
	});
	onDestroy(() => preload.dispose());
	let automaticOwner: ReturnType<typeof preload.align>;
	let automaticAttempted = false;
	$effect(() => {
		const owner = preload.owner;
		const admitted = section === 'upload' && supportAvailable && !!owner;
		if (!admitted || automaticOwner !== owner) {
			automaticOwner = owner;
			automaticAttempted = false;
		}
		if (!admitted || automaticAttempted || !presentation.canStart()) return;
		automaticAttempted = true;
		untrack(() => {
			preload.warm('support');
		});
	});
	const widget = loadComponent(
		() => import('$lib/components/chrome/CsmWidget.svelte'),
		() => eligible && presentation.canStart(),
		() => presentation.painted
	);
	const CsmWidget = $derived(widget.component);
	const notice = loadComponent(
		() => import('$lib/components/chrome/CsmSetupCallBar.svelte'),
		() => eligible && presentation.canStart(),
		() => presentation.painted
	);
	const CsmSetupCallBar = $derived(notice.component);
	let noticeGeneration = $state<string>();
	$effect(() => {
		if (!eligible || noticeGeneration !== generation) noticeGeneration = undefined;
	});
	let initializedGeneration = $state<string>();
	$effect(() => {
		if (!eligible || initializedGeneration !== generation) initializedGeneration = undefined;
	});
	const interactions = setInteractionController(new InteractionController());
	onMount(() => interactions.mount());
</script>

<AppHeader>
	{#snippet notice()}
		{#if CsmSetupCallBar && eligible && (noticeGeneration === generation || presentation.canStart())}
			{#key generation}
				{@const mountedGeneration = generation}
				<CsmSetupCallBar onReady={() => (noticeGeneration = mountedGeneration)} />
			{/key}
		{/if}
		{#if header.notice}{@render header.notice()}{/if}
	{/snippet}
	<WorkspaceStatus announcement={confirmationAnnouncements}>
		{#if header.content}{@render header.content()}{/if}
		<div
			class={`flex w-fit max-w-[min(640px,calc(100vw-32px))] flex-col gap-2 max-[999px]:w-full ${header.content ? 'ml-auto max-w-[calc(100vw-486px)] max-[999px]:max-w-none' : ''}`}
		>
			<CopyConfirmation />
			{#key integrations.confirmation}
				{#if integrations.confirmation}
					<div class="-translate-y-2">
						<StatusBubble>{integrations.confirmation.message}</StatusBubble>
					</div>
				{/if}
			{/key}
			<AppStatus
				feedback={feedback.document?.feedback}
				renderPending={feedback.document?.renderPending}
				renderError={feedback.document?.renderError}
				sourceStale={feedback.document?.sourceStale}
				onRetryRender={feedback.document?.onRetryRender}
			>
				{#snippet saveFeedback()}<WorkspaceSaveStatus />{/snippet}
			</AppStatus>
		</div>
	</WorkspaceStatus>
</AppHeader>
{@render children()}
{#if CsmWidget && eligible && support && (initializedGeneration === generation || presentation.canStart())}
	{#key generation}
		{@const mountedGeneration = generation}
		<CsmWidget
			content={supportContent(support)}
			upload={section === 'upload'}
			onReady={() => (initializedGeneration = mountedGeneration)}
			canStart={() => eligible && presentation.canStart()}
		/>
	{/key}
{/if}

<CsmDialogHost />
