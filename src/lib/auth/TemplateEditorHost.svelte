<script lang="ts">
	import { untrack } from 'svelte';
	import { afterNavigate, onNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import LoadingState from '$lib/ui/LoadingState.svelte';
	import DocumentSkeleton from '$lib/components/document/DocumentSkeleton.svelte';
	import WorkspaceRouteFrame from '$lib/components/workspace/WorkspaceRouteFrame.svelte';
	import type { TemplateRouteFrameState } from '$lib/components/workspace/template-route-frame';
	import { loadDocumentSearch } from '$lib/components/document/document-tools';
	import { getTemplateAuthoringSession } from '$lib/playbook/template-authoring-session.svelte';
	import { useViewer, useViewerSession } from './viewer-session.svelte';
	import { getWorkspaceDestinations } from './workspace-context.svelte';
	import { loadComponent } from './component-loader.svelte';
	import { loadTemplateWorkspace } from './destination-code';
	import WorkspacePresentationReporter from './WorkspacePresentationReporter.svelte';

	let {
		admitted,
		deletionPending,
		hostReady,
		hostError,
		onRetryHost
	}: {
		admitted: boolean;
		deletionPending: boolean;
		hostReady: boolean;
		hostError: string;
		onRetryHost: () => void;
	} = $props();

	const session = useViewerSession();
	const viewer = useViewer();
	const destinations = getWorkspaceDestinations();
	const repAuthoring = getTemplateAuthoringSession('rep');
	const buyerAuthoring = getTemplateAuthoringSession('buyer');

	const template = loadComponent(
		loadTemplateWorkspace,
		() => admitted && !deletionPending,
		() => session.transportGeneration
	);
	const TemplateWorkspace = $derived(template.component);
	let templateFrame = $state.raw<TemplateRouteFrameState>();

	$effect(() => {
		if (admitted && !deletionPending) void loadDocumentSearch().catch(() => {});
	});
	$effect(() => {
		if (
			!admitted ||
			deletionPending ||
			session.blocked ||
			session.closing ||
			!viewer().permissions.manageTemplate
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
		if (admitted) templateAudience = page.url.pathname === '/template/buyers' ? 'buyer' : 'rep';
	});

	let templateMounted = $state(false);
	let templateDetour = $state(false);
	onNavigate(({ to }) => {
		if (
			to?.route.id === '/(workspace)/settings' &&
			templateMounted &&
			(deletionPending || templateDetour)
		)
			templateDetour = true;
	});
	afterNavigate(({ to }) => {
		// Clear only after commit: Settings must retain its owner while returning to Template.
		if (to?.route.id !== '/(workspace)/settings') templateDetour = false;
	});
	$effect(() => {
		if (admitted && TemplateWorkspace && hostReady && !deletionPending) templateMounted = true;
		else if (!admitted && !(page.route.id === '/(workspace)/settings' && templateDetour))
			templateMounted = false;
	});
</script>

{#if (templateMounted && TemplateWorkspace) || (admitted && !deletionPending)}
	<div hidden={!admitted} inert={!admitted}>
		<WorkspaceRouteFrame
			kind="template"
			audience={templateAudience}
			helpVariant={templateAudience === 'buyer' ? 'buyer-template' : 'template'}
			helpReady={activeTemplateFrame?.workspace.viewer.layoutPrepared ?? false}
			active={admitted &&
				viewer().permissions.manageTemplate &&
				(activeTemplateFrame?.available ?? true)}
			workspace={activeTemplateFrame?.workspace}
			interactionOwner={activeTemplateFrame?.interactionOwner}
		>
			{#if templateMounted && TemplateWorkspace}
				{#key templateAudience}<TemplateWorkspace
						audience={templateAudience}
						active={admitted}
						onFrame={(next) => {
							templateFrame = next;
							return () => {
								if (templateFrame === next) templateFrame = undefined;
							};
						}}
					/>{/key}
			{:else if template.failed || hostError}
				<WorkspacePresentationReporter outcome="error" />
				<LoadingState layout="workspace">
					<p role="alert" class="text-sm">
						{template.failed ? 'Unable to load the template editor.' : hostError}
					</p>
					<button
						class="text-sm underline"
						onclick={() => {
							template.retry();
							onRetryHost();
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
