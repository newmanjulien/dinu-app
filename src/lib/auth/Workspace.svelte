<script lang="ts">
	import LoadingWheel from '$lib/ui/LoadingWheel.svelte';
	import BaselineSetup from '$lib/components/template/BaselineSetup.svelte';
	import { page } from '$app/state';
	import { useViewer, useViewerSession } from './viewer-session.svelte';
	import { DocumentResources, setDocumentResources } from '$lib/document/runtime/resources.svelte';
	import { env } from '$env/dynamic/public';
	import { loadComponent } from './component-loader.svelte';
	import { recordStartup } from './startup-perf';
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
	import { InteractionController, setInteractionController } from '$lib/components/ui/interactions';
	let { children }: { children: Snippet } = $props();
	const interactions = setInteractionController(new InteractionController());
	const session = useViewerSession();
	const viewer = useViewer();
	const cache = getContractSnapshotCache();
	onMount(() => interactions.mount());
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
		!viewer().templateReady && ['/admin', '/contracts/new'].includes(page.url.pathname)
	);
	const documentRoute = $derived(/^\/(admin|contracts)(\/|$)/.test(page.url.pathname));
	const deletionPending = $derived(Boolean(viewer().company.deletionPending));
	const needsDocumentHost = $derived(documentRoute && !templatePending && !deletionPending);
	const host = loadComponent(
		() => import('./DocumentHost.svelte'),
		() =>
			!deletionPending && (needsDocumentHost || Boolean(resources?.preparationCandidates.length)),
		() => session.transportGeneration,
		(module) => {
			if (resources) resources.createWorkspace = module.createContractWorkspace;
		}
	);
	const DocumentHost = $derived(host.component);
	const hostError = $derived(host.failed ? 'Unable to load the document viewer. Try again.' : '');
	$effect(() => {
		if (page.url.pathname !== '/' && (!needsDocumentHost || DocumentHost))
			untrack(() => recordStartup('usable'));
	});
	onNavigate(({ to }) => {
		if (deletionPending) return;
		const path = to?.url.pathname;
		const id = path === '/admin' ? 'admin' : path?.match(/^\/contracts\/([^/]+)\/?$/)?.[1];
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
		if (deletionPending) {
			cache.cancelPending();
			resources?.candidates([]);
		}
	});
</script>

{#if deletionPending}
	<div role="status" class="bg-stone-100 px-6 py-4 text-sm leading-6 text-stone-700">
		Company activity is paused while account deletion is confirmed.
		<a href="/settings" class="underline">Open Settings to finish or cancel deletion.</a>
	</div>
{/if}
{#if deletionPending && page.url.pathname !== '/settings'}
	<div class="p-6 text-sm text-stone-700">
		Your company data will be removed after account deletion is confirmed.
	</div>
{:else if templatePending}
	<BaselineSetup getNavigationIntent={() => navigationIntent} />
{:else if !documentRoute || DocumentHost}{@render children()}
{:else if !hostError}<div class="flex justify-center py-16">
		<LoadingWheel label="Loading document viewer" />
	</div>{/if}
{#if needsDocumentHost && hostError}<p role="alert" class="p-4 text-sm">
		{hostError} <button class="underline" onclick={host.retry}>Try again</button>
	</p>{/if}
{#if DocumentHost && !deletionPending}<DocumentHost profiles={layoutProfiles} {resources} />{/if}
