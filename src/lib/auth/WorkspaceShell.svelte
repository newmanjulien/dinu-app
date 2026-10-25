<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { page } from '$app/state';
	import { loadComponent } from './component-loader.svelte';
	import AppHeader from '$lib/components/chrome/AppHeader.svelte';
	import WorkspaceSaveStatus from '$lib/components/chrome/WorkspaceSaveStatus.svelte';
	import { setHeaderContent } from '$lib/components/chrome/header-content.svelte';
	import { InteractionController, setInteractionController } from '$lib/components/ui/interactions';
	import { useViewer, useViewerSession } from './viewer-session.svelte';
	import { setWorkspaceReadiness } from './workspace-readiness.svelte';
	import WorkspaceHelp from './WorkspaceHelp.svelte';
	let { children }: { children: Snippet } = $props();
	const viewer = useViewer();
	const session = useViewerSession();
	const header = setHeaderContent();
	const readiness = setWorkspaceReadiness();
	const desktop = new MediaQuery('(min-width: 1000px)', false);
	let widgetEligible = $state(false);
	$effect(() => {
		if (desktop.current) widgetEligible = true;
	});
	const widgetAllowed = $derived(
		widgetEligible &&
			readiness.painted &&
			viewer().profile.role === 'admin' &&
			!session.blocked &&
			!session.closing
	);
	const pathname = $derived(page.url.pathname);
	const widget = loadComponent(
		() => import('$lib/components/chrome/DelegationWidget.svelte'),
		() => widgetAllowed,
		() => `${session.transportGeneration}:${pathname}`
	);
	const DelegationWidget = $derived(widget.component);
	const interactions = setInteractionController(new InteractionController());
	onMount(() => interactions.mount());
</script>

<AppHeader>
	{#snippet actions()}<WorkspaceSaveStatus />{/snippet}
	{#if header.content}{@render header.content()}{/if}
</AppHeader>
<WorkspaceHelp>{@render children()}</WorkspaceHelp>
{#if widgetAllowed && DelegationWidget}
	{#key `${session.userId}:${viewer().membership.id}:${session.prepared}:${session.transportGeneration}`}
		<DelegationWidget />
	{/key}
{/if}
