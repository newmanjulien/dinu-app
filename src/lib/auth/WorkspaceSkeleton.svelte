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
	import DocumentHeading from '$lib/components/document/DocumentHeading.svelte';
	import DocumentSection from '$lib/components/document/DocumentSection.svelte';
	import UtilityRail from '$lib/components/chrome/UtilityRail.svelte';
	import type { ToolStates } from '$lib/components/document/document-tools';
	import TemplateSetupLayout from '$lib/components/template/TemplateSetupLayout.svelte';
	import ModalShell from '$lib/ui/ModalShell.svelte';
	import IntegrationDetailsLayout from '$lib/components/workspace/IntegrationDetailsLayout.svelte';
	import { findIntegrationDetails } from '$lib/integrations';
	import GuidesLayout from '$lib/components/workspace/GuidesLayout.svelte';
	import { goto } from '$app/navigation';
	import { useAccount } from './viewer-session.svelte';
	import { onDestroy } from 'svelte';
	import { useContractsSearch } from '$lib/components/workspace/contracts-search.svelte';
	import SearchField from '$lib/ui/SearchField.svelte';
	import Button from '$lib/ui/Button.svelte';
	import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
	let {
		header = false,
		label = 'Loading your workspace',
		announce = true,
		children
	}: {
		header?: boolean;
		label?: string;
		announce?: boolean;
		children?: Snippet;
	} = $props();
	const route = $derived(describeRoute(page.route.id));
	const hints = useWorkspaceHints();
	const account = useAccount();
	const contractsSearch = useContractsSearch();
	const searchState = $derived(contractsSearch?.current);
	let searchInput = $state<HTMLInputElement | null>();
	onDestroy(() => {
		if (searchInput) searchState?.rememberFocus(searchInput);
	});
	const viewer = $derived(account?.());
	const presentation = $derived(
		viewer?.membership && viewer.company
			? {
					name: viewer.profile.name,
					avatarUrl: viewer.profile.avatarUrl,
					companyName: viewer.company.name,
					companyAvatarUrl: viewer.company.avatarUrl,
					instructionsReady: viewer.instructionsReady
				}
			: viewer !== undefined
				? undefined
				: hints.presentation
	);
	const role = $derived(viewer?.membership?.role ?? hints.role);
	const templateReady = $derived(viewer?.membership ? viewer.templateReady : hints.templateReady);
	const integration = $derived(findIntegrationDetails(page.params.slug ?? ''));
	const creationPending = $derived(route.document === 'new' && templateReady !== false);
	const creationTools: ToolStates = {
		search: { applicability: 'present', display: 'ready', enabled: false },
		download: { applicability: 'absent', display: 'ready' },
		settings: { applicability: 'absent', display: 'ready' },
		help: { applicability: 'present', display: 'ready', enabled: false }
	};
</script>

{#if announce && !creationPending}<span role="status" class="sr-only">{label}</span>{/if}
{#if header}
	<AppHeaderLayout
		{role}
		templateReady={templateReady ?? false}
		profile={presentation?.name !== undefined
			? { name: presentation.name, avatarUrl: presentation.avatarUrl ?? null }
			: undefined}
	/>
{/if}
{#if route.requiresTemplate && templateReady === false}
	<TemplateSetupLayout {role} />
{:else if route.document === 'new'}
	<div inert aria-hidden="true" class="pointer-events-none">
		<UtilityRail states={creationTools} />
		<DocumentHeading kind="saved" />
	</div>
	<ModalShell
		title="Create a contract"
		onClose={() => goto('/contracts')}
		showCloseButton={false}
		closeOnBackdrop={false}
	>
		{#if children}<div class="mt-4 grid gap-3">{@render children()}</div>{/if}
		{#snippet footer()}
			<div class="ml-auto flex gap-2">
				<Button variant="secondary" onclick={() => goto('/contracts')}>Cancel</Button>
				<Button disabled>Create contract</Button>
			</div>
		{/snippet}
	</ModalShell>
{:else if route.presentation === 'document'}
	<DocumentSection>
		{#snippet heading()}
			<DocumentHeading
				kind={route.document === 'template' ? 'template' : 'saved'}
				audience={page.url.pathname === '/template/buyers' ? 'buyer' : 'rep'}
			/>
		{/snippet}
		<DocumentSkeleton
			reserveReviewGutter={route.document === 'saved'}
			template={route.document === 'template'}
			announce={false}
		/>
	</DocumentSection>
{:else if route.presentation === 'contracts'}
	<ContractsLayout {role}>
		{#snippet toolbar()}
			{#if searchState}
				<SearchField
					bind:element={searchInput}
					label="Search contracts"
					placeholder="Search by name of company"
					maxlength={200}
					bind:value={searchState.value}
				/>
			{:else}
				<SearchField label="Search contracts" placeholder="Search by name of company" />
			{/if}
			<Button disabled><PlusIcon class="size-[15px]" aria-hidden="true" />New contract</Button>
		{/snippet}
	</ContractsLayout>
{:else if route.presentation === 'settings'}
	<SettingsLayout {role} {presentation} />
{:else if route.presentation === 'contract-settings'}
	<ContractSettingsLayout />
{:else if route.presentation === 'team'}
	<TeamLayout
		{role}
		companyName={presentation?.companyName}
		canManage={viewer?.permissions.manageMembers ?? false}
	/>
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
