<script lang="ts">
	import { onDestroy, onMount, tick, untrack, type Snippet } from 'svelte';
	import { navigating, page } from '$app/state';
	import AppHeader from '$lib/components/chrome/AppHeader.svelte';
	import WorkspaceSaveStatus from '$lib/components/chrome/WorkspaceSaveStatus.svelte';
	import AppStatus from '$lib/components/chrome/AppStatus.svelte';
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
	let { children }: { children: Snippet } = $props();
	const header = setHeaderContent();
	const feedback = getWorkspaceFeedback();
	const viewer = useViewer();
	const session = useViewerSession();
	const supportAvailable = $derived(
		!session.blocked && !session.closing && !viewer().company.deletionPending
	);
	const setupAvailable = $derived(
		supportAvailable &&
			describeRoute(page.route.id).document === 'admin' &&
			viewer().membership.role === 'admin' &&
			viewer().templateReady
	);
	// This fact belongs to the membership, beyond a launcher or connection lifetime.
	let optimisticSetupBooked = $state(false);
	const setupBooked = $derived(viewer().company.csmCallBooked || optimisticSetupBooked);
	const eligible = $derived(supportAvailable && (setupBooked || setupAvailable));
	const noticeEligible = $derived(supportAvailable && viewer().membership.role === 'admin');
	const generation = $derived(`${session.preparedSessionId}:${session.transportGeneration}`);
	const presentation = setWorkspacePresentation(
		() =>
			JSON.stringify([
				page.route.id,
				page.url.pathname,
				page.url.search,
				generation,
				describeRoute(page.route.id).baseline ? viewer().templateReady : null
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
	const preload = setCsmPreload(
		() => presentation.canStart(),
		() => setupBooked
	);
	$effect(() => {
		preload.align();
	});
	const dialog = setCsmDialog(
		() => supportAvailable && presentation.canStart(),
		() => setupAvailable,
		() => (optimisticSetupBooked = true)
	);
	$effect(() => {
		dialog.align();
	});
	onDestroy(() => preload.dispose());
	let automaticOwner: ReturnType<typeof preload.align>;
	let automaticAttempted = false;
	$effect(() => {
		const owner = preload.owner;
		const admitted =
			describeRoute(page.route.id).document === 'admin' &&
			!setupBooked &&
			viewer().permissions.manageTemplate &&
			!!owner;
		if (!admitted || automaticOwner !== owner) {
			automaticOwner = owner;
			automaticAttempted = false;
		}
		if (!admitted || automaticAttempted || !presentation.canStart()) return;
		automaticAttempted = true;
		untrack(() => preload.warm('setup'));
	});
	const widget = loadComponent(
		() => import('$lib/components/chrome/CsmWidget.svelte'),
		() => eligible && presentation.canStart(),
		() => presentation.painted
	);
	const CsmWidget = $derived(widget.component);
	const notice = loadComponent(
		() => import('$lib/components/chrome/CsmSetupCallBar.svelte'),
		() => noticeEligible && presentation.canStart(),
		() => presentation.painted
	);
	const CsmSetupCallBar = $derived(notice.component);
	let noticeGeneration = $state<string>();
	$effect(() => {
		if (!noticeEligible || noticeGeneration !== generation) noticeGeneration = undefined;
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
		{#if CsmSetupCallBar && noticeEligible && (noticeGeneration === generation || presentation.canStart())}
			{#key generation}
				{@const mountedGeneration = generation}
				<CsmSetupCallBar onReady={() => (noticeGeneration = mountedGeneration)} />
			{/key}
		{/if}
		{#if header.notice}{@render header.notice()}{/if}
	{/snippet}
	<div
		class="pointer-events-none absolute top-[calc(100%+20px)] right-0 left-0 flex justify-center max-[999px]:top-[calc(100%+8px)] max-[999px]:right-3 max-[999px]:left-auto max-[999px]:w-[min(454px,calc(100vw-24px))] max-[999px]:flex-col max-[999px]:items-end max-[999px]:gap-2"
	>
		{#if header.content}{@render header.content()}{/if}
		<div
			class={`flex w-fit max-w-[min(640px,calc(100vw-32px))] flex-col gap-2 max-[999px]:w-full ${header.content ? 'ml-auto max-w-[calc(100vw-486px)] max-[999px]:max-w-none' : ''}`}
		>
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
	</div>
</AppHeader>
{@render children()}
{#if CsmWidget && eligible && (initializedGeneration === generation || presentation.canStart())}
	{#key generation}
		{@const mountedGeneration = generation}
		<CsmWidget
			mode={setupBooked ? 'support' : 'setup'}
			onReady={() => (initializedGeneration = mountedGeneration)}
			canStart={() => eligible && presentation.canStart()}
		/>
	{/key}
{/if}

{#if dialog.request}
	{#key dialog.request}
		<CsmDialogHost />
	{/key}
{/if}
