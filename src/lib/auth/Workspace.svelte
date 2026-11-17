<script lang="ts">
	import { flushDownloadAcks } from '$lib/contract/download-journal';
	import { useConvexClient } from 'convex-svelte';
	import { page } from '$app/state';
	import LoadingState from '$lib/ui/LoadingState.svelte';
	import DocumentSkeleton from '$lib/components/document/DocumentSkeleton.svelte';
	import WorkspaceRouteFrame from '$lib/components/workspace/WorkspaceRouteFrame.svelte';
	import type { TemplateRouteFrameState } from '$lib/components/workspace/template-route-frame';
	import { loadDocumentSearch } from '$lib/components/document/document-tools';
	import { useViewer, useViewerSession } from './viewer-session.svelte';
	import { DocumentResources, setDocumentResources } from '$lib/document/runtime/resources.svelte';
	import { env } from '$env/dynamic/public';
	import { loadComponent, loadModule } from './component-loader.svelte';
	import {
		loadDocumentHost,
		loadDocumentWorkspace,
		loadTemplateWorkspace
	} from './destination-code';
	import { recordStartup } from './startup-perf';
	import WorkspacePresentationReporter from './WorkspacePresentationReporter.svelte';
	import { useWorkspacePresentation } from './workspace-presentation.svelte';
	import { browser } from '$app/environment';
	import { beforeNavigate, afterNavigate, onNavigate } from '$app/navigation';
	import { getContractSnapshotCache } from '$lib/contract/snapshot-cache';
	import {
		recordDocumentNavigation,
		cancelDocumentNavigation
	} from '$lib/document/runtime/render-perf';
	import {
		DocumentLayoutProfiles,
		setDocumentLayoutProfiles
	} from '$lib/document/runtime/layout-context.svelte';
	import { onMount, onDestroy, type Snippet, untrack } from 'svelte';
	import { describeRoute } from './routes';
	import { setWorkspaceRuntime, getWorkspaceDestinations } from './workspace-context.svelte';
	import { getTemplateAuthoringSession } from '$lib/playbook/template-authoring-session.svelte';
	let { children }: { children: Snippet } = $props();
	const session = useViewerSession();
	const presentation = useWorkspacePresentation();
	const viewer = useViewer();
	const client = useConvexClient();
	const repAuthoring = getTemplateAuthoringSession();
	const buyerAuthoring = getTemplateAuthoringSession('buyer');
	const cache = getContractSnapshotCache(client);
	const destinations = getWorkspaceDestinations();
	$effect(() => {
		destinations?.configure(Boolean(presentation?.canStart()));
	});
	$effect(() => {
		const membershipId = viewer().membership.id;
		void session.transportGeneration;
		if (session.blocked || session.closing || viewer().company.deletionPending) return;
		const flush = () => {
			void flushDownloadAcks(client, membershipId);
		};
		untrack(flush);
		const timer = setInterval(flush, 30_000);
		return () => clearInterval(timer);
	});
	let navigationIntent = 0;

	beforeNavigate((navigation) => {
		navigationIntent++;
		if (navigation.to) recordDocumentNavigation(navigation.to.url.pathname);
		const destination = describeRoute(navigation.to?.route.id ?? null);
		const release = cache.reserveNavigation(
			!deletionPending &&
				!session.blocked &&
				!navigation.willUnload &&
				destination.document === 'saved'
				? navigation.to?.params?.id
				: undefined
		);
		void navigation.complete.then(release, release);
	});
	afterNavigate((navigation) => {
		if (!navigation.to) return;
		if (browser && navigation.type === 'enter')
			recordDocumentNavigation(navigation.to.url.pathname, 0);
		else if (describeRoute(navigation.to.route.id).presentation === 'contracts')
			cancelDocumentNavigation();
	});
	// A persistent host preserves the existing mount-specific epoch safety.
	// Disable independently to return to viewer-owned, fresh geometry.
	const layoutProfiles =
		env.PUBLIC_DOCUMENT_ROUTE_PROFILES === '0'
			? undefined
			: setDocumentLayoutProfiles(new DocumentLayoutProfiles());
	const templatePending = $derived(
		!viewer().templateReady && Boolean(describeRoute(page.route.id).requiresTemplate)
	);
	const route = $derived(describeRoute(page.route.id));
	const documentRoute = $derived(Boolean(route.document));
	const deletionPending = $derived(Boolean(viewer().company.deletionPending));
	const needsDocumentHost = $derived(documentRoute && !templatePending && !deletionPending);
	let resources = $state.raw<DocumentResources>();
	const backgroundPreparation = $derived(
		Boolean(resources?.backgroundEnabled && resources.preparationCandidates.length)
	);
	const workspaceModule = loadModule(
		loadDocumentWorkspace,
		() =>
			Boolean(layoutProfiles) && !deletionPending && (needsDocumentHost || backgroundPreparation),
		() => session.transportGeneration
	);
	if (layoutProfiles && env.PUBLIC_DOCUMENT_PREPARATION !== '0')
		resources = setDocumentResources(
			new DocumentResources(layoutProfiles, () => workspaceModule.module?.createDocumentWorkspace)
		);
	const host = loadComponent(
		loadDocumentHost,
		() => !deletionPending && (needsDocumentHost || backgroundPreparation),
		() => session.transportGeneration
	);
	const DocumentHost = $derived(host.component);
	const workspaceReady = $derived(
		!layoutProfiles || !needsDocumentHost || Boolean(workspaceModule.module)
	);
	const hostError = $derived(
		host.failed
			? 'Unable to load the document viewer. Try again.'
			: needsDocumentHost && workspaceModule.failed
				? 'Unable to load the document workspace. Try again.'
				: ''
	);
	const runtime = setWorkspaceRuntime({
		get hostReady() {
			return Boolean(DocumentHost) && workspaceReady;
		},
		get paused() {
			return deletionPending;
		},
		get error() {
			return hostError;
		},
		get navigationIntent() {
			return navigationIntent;
		},
		retry: () => {
			presentation?.restart();
			host.retry();
			workspaceModule.retry();
		}
	});
	const template = loadComponent(
		loadTemplateWorkspace,
		() => route.document === 'template' && !templatePending && !deletionPending,
		() => session.transportGeneration
	);
	const TemplateWorkspace = $derived(template.component);
	let templateFrame = $state.raw<TemplateRouteFrameState>();
	$effect(() => {
		if (route.document === 'template' && !templatePending && !deletionPending)
			void loadDocumentSearch().catch(() => {});
	});
	$effect(() => {
		if (
			route.document !== 'template' ||
			templatePending ||
			deletionPending ||
			session.blocked ||
			session.closing ||
			viewer().membership.role !== 'admin'
		)
			return;
		const audience = page.url.pathname === '/template/buyers' ? 'buyer' : 'rep';
		const authoring = audience === 'buyer' ? buyerAuthoring : repAuthoring;
		return untrack(() => destinations?.retain(page.url.pathname) ?? authoring.retainReads());
	});
	let templateAudience = $state<'rep' | 'buyer'>(
		untrack(() => (page.url.pathname === '/template/buyers' ? 'buyer' : 'rep'))
	);
	const activeTemplateFrame = $derived(
		templateFrame?.audience === templateAudience ? templateFrame : undefined
	);
	$effect(() => {
		if (route.document === 'template')
			templateAudience = page.url.pathname === '/template/buyers' ? 'buyer' : 'rep';
	});
	let templateMounted = $state(false);
	let templateDetour = $state(false);
	afterNavigate(({ to }) => {
		// Clear only after commit: Settings must retain its owner while returning to Admin.
		if (to?.route.id !== '/(workspace)/settings') templateDetour = false;
	});
	$effect(() => {
		if (
			route.document === 'template' &&
			TemplateWorkspace &&
			runtime.hostReady &&
			!templatePending &&
			!deletionPending
		)
			templateMounted = true;
		else if (
			route.document !== 'template' &&
			!(page.route.id === '/(workspace)/settings' && templateDetour)
		)
			templateMounted = false;
	});
	$effect(() => {
		if (route.presentation !== 'contracts' && (!needsDocumentHost || DocumentHost)) {
			untrack(() => recordStartup('usable'));
		}
	});
	onNavigate(({ to, complete }) => {
		if (
			to?.route.id === '/(workspace)/settings' &&
			templateMounted &&
			(deletionPending || templateDetour)
		)
			templateDetour = true;
		if (deletionPending) return;
		if (to) {
			const release = destinations?.navigate(to.url.pathname);
			void complete.catch(() => release?.());
		}
		const destination = describeRoute(to?.route.id ?? null);
		const id =
			destination.document === 'template'
				? to?.url.pathname === '/template/buyers'
					? 'template:buyer'
					: 'template'
				: destination.document === 'saved'
					? to?.params?.id
					: undefined;

		return id ? resources?.beginOpen(id) : undefined;
	});
	onMount(() =>
		resources
			? cache.subscribe(
					(data) => resources.prepare(data),
					(id) => resources.remove(id),
					(id) => resources.failedPreparation(id)
				)
			: undefined
	);
	onDestroy(() => {
		navigationIntent++;
		cache.cancelPending();
		resources?.destroy();
		layoutProfiles?.scheduler.destroy();
	});
	$effect(() => {
		if (resources) resources.paused = deletionPending;
		if (deletionPending) {
			cache.cancelPending();
			resources?.candidates([]);
		}
	});
</script>

<div
	hidden={deletionPending && !route.availableDuringHold}
	inert={deletionPending && !route.availableDuringHold}
>
	<!-- Retain document owners; other bodies release their queries, shortcuts, and modals. -->
	{#if !deletionPending || documentRoute || route.availableDuringHold}
		{@render children()}
	{/if}
</div>
{#if (templateMounted && TemplateWorkspace) || (route.document === 'template' && !templatePending && !deletionPending)}
	<div hidden={route.document !== 'template'} inert={route.document !== 'template'}>
		<WorkspaceRouteFrame
			kind="template"
			audience={templateAudience}
			helpVariant={templateAudience === 'buyer' ? 'buyer-template' : 'template'}
			helpReady={activeTemplateFrame?.workspace.viewer.layoutPrepared ?? false}
			active={route.document === 'template' &&
				viewer().membership.role === 'admin' &&
				(activeTemplateFrame?.available ?? true)}
			workspace={activeTemplateFrame?.workspace}
			interactionOwner={activeTemplateFrame?.interactionOwner}
		>
			{#if templateMounted && TemplateWorkspace}
				{#key templateAudience}<TemplateWorkspace
						audience={templateAudience}
						active={route.document === 'template'}
						onFrame={(next) => {
							templateFrame = next;
							return () => {
								if (templateFrame === next) templateFrame = undefined;
							};
						}}
					/>{/key}
			{:else if template.failed || runtime.error}
				<WorkspacePresentationReporter outcome="error" />
				<LoadingState layout="workspace">
					<p role="alert" class="text-sm">
						{template.failed ? 'Unable to load the template editor.' : runtime.error}
					</p>
					<button
						class="text-sm underline"
						onclick={() => {
							template.retry();
							runtime.retry();
						}}>Try again</button
					>
				</LoadingState>
			{:else}
				<WorkspacePresentationReporter outcome="pending" />
				<DocumentSkeleton template label="Loading template editor" />
			{/if}
		</WorkspaceRouteFrame>
	</div>
{/if}
{#if DocumentHost}<DocumentHost
		profiles={layoutProfiles}
		{resources}
		paused={deletionPending}
	/>{/if}
