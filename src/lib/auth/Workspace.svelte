<script lang="ts">
	import { useConvexClient } from 'convex-svelte';
	import { page } from '$app/state';
	import { useViewer, useViewerSession } from './viewer-session.svelte';
	import { DocumentResources, setDocumentResources } from '$lib/document/runtime/resources.svelte';
	import { env } from '$env/dynamic/public';
	import { loadComponent, loadModule } from './component-loader.svelte';
	import { loadDocumentHost, loadDocumentWorkspace } from './destination-code';
	import { recordStartup } from './startup-perf';
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
	import { resolveWorkspaceRoute } from './workspace-admission';
	import { setWorkspaceRuntime, getWorkspaceDestinations } from './workspace-context.svelte';
	import TemplateEditorHost from './TemplateEditorHost.svelte';
	import WorkspaceRedirect from './WorkspaceRedirect.svelte';

	let { children }: { children: Snippet } = $props();
	const session = useViewerSession();
	const presentation = useWorkspacePresentation();
	const viewer = useViewer();
	const client = useConvexClient();
	const cache = getContractSnapshotCache(client);
	const destinations = getWorkspaceDestinations();
	$effect(() => {
		destinations?.configure(Boolean(presentation?.canStart()));
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
	const route = $derived(describeRoute(page.route.id));
	const documentRoute = $derived(Boolean(route.document));
	const deletionPending = $derived(Boolean(viewer().company.deletion));
	const admission = $derived(resolveWorkspaceRoute(route, viewer()));
	const admitted = $derived(admission.kind === 'allow');
	const needsDocumentHost = $derived(documentRoute && admitted && !deletionPending);
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
	$effect(() => {
		if (route.presentation !== 'contracts' && (!needsDocumentHost || DocumentHost)) {
			untrack(() => recordStartup('usable'));
		}
	});
	onNavigate(({ to, complete }) => {
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
	{#if admission.kind === 'redirect' && !deletionPending}
		<WorkspaceRedirect
			to={admission.to}
			label={admission.label}
			errorMessage={admission.errorMessage}
			disabled={session.blocked || session.closing}
		/>
	{:else if admitted && (!deletionPending || documentRoute || route.availableDuringHold)}
		{@render children()}
	{/if}
</div>
<TemplateEditorHost
	admitted={admitted && route.document === 'template'}
	{deletionPending}
	hostReady={runtime.hostReady}
	hostError={runtime.error}
	onRetryHost={runtime.retry}
/>
{#if DocumentHost}<DocumentHost
		profiles={layoutProfiles}
		{resources}
		paused={deletionPending}
	/>{/if}
