<script lang="ts">
	import { useConvexClient } from 'convex-svelte';
	import { page } from '$app/state';
	import LoadingState from '$lib/ui/LoadingState.svelte';
	import WorkspaceSkeleton from './WorkspaceSkeleton.svelte';
	import { useViewer, useViewerSession } from './viewer-session.svelte';
	import { DocumentResources, setDocumentResources } from '$lib/document/runtime/resources.svelte';
	import { env } from '$env/dynamic/public';
	import { loadComponent } from './component-loader.svelte';
	import { afterStartupPaint, recordStartup } from './startup-perf';
	import { useWorkspaceReadiness } from './workspace-readiness.svelte';
	import { browser } from '$app/environment';
	import { beforeNavigate, afterNavigate, onNavigate } from '$app/navigation';
	import { getContractSnapshotCache } from '$lib/contract/snapshot-cache';
	import {
		recordDocumentNavigation,
		cancelDocumentNavigation
	} from '$lib/document/runtime/render-perf';
	import {
		ContractLayoutProfiles,
		setContractLayoutProfiles
	} from '$lib/document/runtime/layout-context.svelte';
	import { onMount, onDestroy, type Snippet, untrack } from 'svelte';
	import { describeRoute } from './routes';
	import { setWorkspaceRuntime } from './workspace-context.svelte';
	import { setDocumentNavigation } from '$lib/document/runtime/navigation.svelte';
	let { children }: { children: Snippet } = $props();
	const session = useViewerSession();
	const readiness = useWorkspaceReadiness();
	const viewer = useViewer();
	const cache = getContractSnapshotCache(useConvexClient());
	let navigationIntent = 0;

	beforeNavigate((navigation) => {
		navigationIntent++;
		if (navigation.to) recordDocumentNavigation(navigation.to.url.pathname);
	});
	afterNavigate((navigation) => {
		if (!navigation.to) return;
		if (browser && navigation.type === 'enter')
			recordDocumentNavigation(navigation.to.url.pathname, 0);
		else if (navigation.to.url.pathname === '/') cancelDocumentNavigation();
	});
	// A persistent host preserves the existing mount-specific epoch safety.
	// Disable independently to return to viewer-owned, fresh geometry.
	const layoutProfiles =
		env.PUBLIC_CONTRACT_ROUTE_PROFILES === '0'
			? undefined
			: setContractLayoutProfiles(new ContractLayoutProfiles());
	const resources =
		layoutProfiles && env.PUBLIC_CONTRACT_DOCUMENT_PREPARATION !== '0'
			? setDocumentResources(new DocumentResources(layoutProfiles))
			: undefined;
	const templatePending = $derived(
		!viewer().templateReady && Boolean(describeRoute(page.route.id).baseline)
	);
	const route = $derived(describeRoute(page.route.id));
	const documentRoute = $derived(Boolean(route.document));
	const deletionPending = $derived(Boolean(viewer().company.deletionPending));
	const needsDocumentHost = $derived(documentRoute && !templatePending && !deletionPending);
	const host = loadComponent(
		() => import('./DocumentHost.svelte'),
		() =>
			!deletionPending &&
			(needsDocumentHost ||
				Boolean(resources?.backgroundEnabled && resources.preparationCandidates.length)),
		() => session.transportGeneration,
		(module) => {
			if (resources) resources.createWorkspace = module.createContractWorkspace;
		}
	);
	const DocumentHost = $derived(host.component);
	const hostError = $derived(host.failed ? 'Unable to load the document viewer. Try again.' : '');
	const runtime = setWorkspaceRuntime({
		get ready() {
			return Boolean(DocumentHost);
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
		retry: host.retry
	});
	setDocumentNavigation();
	const admin = loadComponent(
		() => import('$lib/components/workspace/AdminWorkspace.svelte'),
		() => route.document === 'admin' && !templatePending && !deletionPending,
		() => session.transportGeneration
	);
	const AdminWorkspace = $derived(admin.component);
	let adminMounted = $state(false);
	let adminDetour = $state(false);
	afterNavigate(({ to }) => {
		// Clear only after commit: Settings must retain its owner while returning to Admin.
		if (to?.route.id !== '/(workspace)/settings') adminDetour = false;
	});
	$effect(() => {
		if (
			route.document === 'admin' &&
			AdminWorkspace &&
			runtime.ready &&
			!templatePending &&
			!deletionPending
		)
			adminMounted = true;
		else if (
			route.document !== 'admin' &&
			!(page.route.id === '/(workspace)/settings' && adminDetour)
		)
			adminMounted = false;
	});
	$effect(() => {
		if (page.url.pathname !== '/' && (!needsDocumentHost || DocumentHost)) {
			untrack(() => recordStartup('usable'));
			return afterStartupPaint(() => (readiness.painted = true));
		}
	});
	onNavigate(({ to }) => {
		if (
			to?.route.id === '/(workspace)/settings' &&
			adminMounted &&
			(deletionPending || adminDetour)
		)
			adminDetour = true;
		if (deletionPending) return;
		const destination = describeRoute(to?.route.id ?? null);
		const id =
			destination.document === 'admin'
				? 'admin'
				: destination.document === 'saved'
					? to?.params?.id
					: undefined;
		if (id && id !== 'admin' && id !== 'new') void cache.load(id);
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

{#if deletionPending}
	<div role="status" class="bg-canvas px-6 py-4 text-sm leading-6 text-ink-secondary">
		Company activity is paused while account deletion is confirmed.
		<a href="/settings" class="underline">Open Settings to finish or cancel deletion.</a>
	</div>
{/if}
<div
	hidden={deletionPending && !route.availableDuringHold}
	inert={deletionPending && !route.availableDuringHold}
>
	<!-- Retain document owners; other bodies release their queries, shortcuts, and modals. -->
	{#if !deletionPending || documentRoute || route.availableDuringHold}
		{@render children()}
	{/if}
</div>
{#if adminMounted && AdminWorkspace}
	<AdminWorkspace active={route.document === 'admin'} />
{:else if route.document === 'admin' && !templatePending && !deletionPending && runtime.ready}
	{#if !admin.failed}
		<WorkspaceSkeleton label="Loading contract authoring" />
	{:else}
		<LoadingState layout="workspace">
			<p role="alert" class="text-sm">Unable to load contract authoring.</p>
			<button class="text-sm underline" onclick={admin.retry}>Try again</button>
		</LoadingState>
	{/if}
{/if}
{#if DocumentHost}<DocumentHost
		profiles={layoutProfiles}
		{resources}
		paused={deletionPending}
	/>{/if}
