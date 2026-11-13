<script lang="ts">
	import AppHeaderLayout from '$lib/components/chrome/AppHeaderLayout.svelte';
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	import { describeRoute } from './routes';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	import IntegrationCatalogLayout from '$lib/components/workspace/IntegrationCatalogLayout.svelte';
	import ContractsLayout from '$lib/components/workspace/ContractsLayout.svelte';
	import SettingsLayout from '$lib/components/workspace/SettingsLayout.svelte';
	import ContractSettingsLayout from '$lib/components/workspace/ContractSettingsLayout.svelte';
	import TeamLayout from '$lib/components/workspace/TeamLayout.svelte';
	import { useWorkspaceHints } from './workspace-hints.svelte';
	import DocumentSkeleton from '$lib/components/document/DocumentSkeleton.svelte';
	import TemplateSetupLayout from '$lib/components/template/TemplateSetupLayout.svelte';
	import ContractCreationSkeleton from '$lib/components/workspace/ContractCreationSkeleton.svelte';
	import IntegrationDetailsLayout from '$lib/components/workspace/IntegrationDetailsLayout.svelte';
	import { findIntegrationDetails } from '$lib/integrations';
	import GuidesLayout from '$lib/components/workspace/GuidesLayout.svelte';
	import { goto } from '$app/navigation';
	import { useAccount } from './viewer-session.svelte';
	let {
		header = false,
		hasPanel = false,
		label = 'Loading your workspace',
		announce = true,
		children
	}: {
		header?: boolean;
		hasPanel?: boolean;
		label?: string;
		announce?: boolean;
		children?: Snippet;
	} = $props();
	const route = $derived(describeRoute(page.route.id));
	const hints = useWorkspaceHints();
	const account = useAccount();
	const viewer = $derived(account?.());
	const role = $derived(viewer?.membership?.role ?? hints.role);
	const templateReady = $derived(viewer?.membership ? viewer.templateReady : hints.templateReady);
	const integration = $derived(findIntegrationDetails(page.params.slug ?? ''));
	const creationPending = $derived(route.document === 'new' && templateReady === true);
</script>

{#if announce && !creationPending}<span role="status" class="sr-only">{label}</span>{/if}
{#if header}
	<AppHeaderLayout {role} templateReady={templateReady ?? false} />
{/if}
{#if route.requiresTemplate && templateReady === undefined}
	<div aria-hidden="true" class="mx-auto grid max-w-md gap-3 px-6 py-16">
		<SkeletonBlock class="h-6 w-48 max-w-full" />
		<SkeletonBlock class="h-4 w-full" />
	</div>
{:else if route.requiresTemplate && !templateReady}
	<TemplateSetupLayout {role} />
{:else if route.document === 'new'}
	<main inert aria-hidden="true" class="pointer-events-none pt-6 pb-12 blur-sm">
		<DocumentSkeleton embedded announce={false} />
	</main>
	<ContractCreationSkeleton {announce} {label} {children} onClose={() => goto('/contracts')} />
{:else if route.presentation === 'document'}
	<DocumentSkeleton
		layout={route.document === 'saved' ? 'contract' : 'standard'}
		template={route.document === 'template'}
		{hasPanel}
		announce={false}
	/>
{:else if route.presentation === 'contracts'}
	<ContractsLayout {role} hasBuyerLinks={hints.hasBuyerLinks} />
{:else if route.presentation === 'settings'}
	<SettingsLayout {role} />
{:else if route.presentation === 'contract-settings'}
	<ContractSettingsLayout />
{:else if route.presentation === 'team'}
	<TeamLayout {role} />
{:else if route.presentation === 'integrations'}
	<IntegrationCatalogLayout {role} />
{:else if route.presentation === 'guides'}
	<GuidesLayout {role} />
{:else if route.presentation === 'integration'}
	<IntegrationDetailsLayout {role} {integration} />
{:else}
	<div aria-hidden="true" class="mx-auto grid max-w-md gap-5 px-6 py-16">
		<SkeletonBlock class="h-7 w-48" />
		<SkeletonBlock class="h-5 w-full" />
		<SkeletonBlock class="h-11 w-full rounded-lg" />
		<SkeletonBlock class="h-11 w-full rounded-lg" />
	</div>
{/if}
{#if children && !creationPending}
	<div
		class="fixed inset-x-3 bottom-4 z-50 mx-auto grid max-w-md justify-items-center gap-3 rounded-xl border-hairline border-edge bg-surface p-5 text-center shadow-floating"
	>
		{@render children()}
	</div>
{/if}
