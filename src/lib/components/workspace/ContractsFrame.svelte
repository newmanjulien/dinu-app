<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { navigating } from '$app/state';
	import { loadModule } from '$lib/auth/component-loader.svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { getWorkspaceDestinations } from '$lib/auth/workspace-context.svelte';
	import { afterStartupPaint, recordStartup } from '$lib/auth/startup-perf';
	import { useStartupHome } from '$lib/auth/startup-data';
	import { useWorkspaceReadSnapshots } from '$lib/auth/workspace-read-snapshots.svelte';
	import { useReadQuery } from '$lib/auth/read-query.svelte';
	import { FirstLinkHintVisit } from '$lib/buyer/first-link-hint-visit.svelte';
	import { useCompanySetup } from '$lib/features/company-setup/company-setup.svelte';
	import CompanySetupPrompt from '$lib/features/company-setup/CompanySetupPrompt.svelte';
	import { getInteractionController, setInteractionOwner } from '$lib/components/ui/interactions';
	import SearchField from '$lib/ui/SearchField.svelte';
	import Button from '$lib/ui/Button.svelte';
	import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
	import ContractsLayout from './ContractsLayout.svelte';
	import ContractsCachedResults from './ContractsCachedResults.svelte';
	import { useContractsSearch } from './contracts-search.svelte';
	import { getContracts, loadContracts } from './contracts';
	import { api } from '../../../convex/_generated/api';
	import { useConvexClient } from 'convex-svelte';

	setInteractionOwner(Symbol('contracts'));
	const interactions = getInteractionController();
	const client = useConvexClient();
	const viewer = useViewer();
	const session = useViewerSession();
	const destinations = getWorkspaceDestinations();
	const contractsSearch = useContractsSearch();
	const searchState = $derived(contractsSearch?.current);
	const firstVisit = Boolean(contractsSearch && !contractsSearch.visited);
	const setup = useCompanySetup();
	const reads = useWorkspaceReadSnapshots();
	const membershipId = viewer().membership.id;
	const firstLinkHintVisit =
		contractsSearch?.current?.firstLinkHintVisit(membershipId) ??
		new FirstLinkHintVisit(membershipId);
	const buyerLinkPresence = useReadQuery(api.buyerLinks.dashboardPresence, { membershipId });
	const buyerLinksAvailable = $derived(buyerLinkPresence.data?.hasActive ?? undefined);
	const startupHome = useStartupHome();
	const initialHome = startupHome();
	// Only stage a cold entry that began before setup or contract data was ready.
	const initialResultsReady = Boolean(
		reads?.getDirectory('contracts') ||
		reads?.getBrowse(
			'contracts',
			untrack(() => searchState?.query ?? '')
		) ||
		reads?.get('contracts') ||
		(initialHome?.scope.profileId === viewer().profile.id &&
			initialHome.scope.membershipId === viewer().membership.id &&
			initialHome.scope.companyId === viewer().company.id)
	);
	const needsContentLead = firstVisit && (!setup.resolved || !initialResultsReady);
	const needsSetupLead = $derived(firstVisit && Boolean(setup.progress && !setup.complete));
	let setupLeadElapsed = $state(false);
	let contentLeadElapsed = $state(false);
	const showHeadings = $derived(setup.resolved && (!needsSetupLead || setupLeadElapsed));
	const showContent = $derived(showHeadings && (!needsContentLead || contentLeadElapsed));
	let buyerCardReady = $state(false);
	const showFirstLinkHint = $derived(firstLinkHintVisit.shown);
	$effect(() => {
		if (
			!buyerCardReady ||
			!showContent ||
			searchState?.value.trim() ||
			buyerLinksAvailable !== true ||
			!buyerLinkPresence.data?.hasCreatedOneLink
		)
			return;
		firstLinkHintVisit.claim(client);
	});
	function onFirstLinkCardReady() {
		buyerCardReady = true;
	}
	$effect(() => {
		if (showContent && contractsSearch) contractsSearch.visited = true;
	});
	$effect(() => {
		if (!needsSetupLead || !setup.resolved) return;
		return afterStartupPaint(() => (setupLeadElapsed = true));
	});
	$effect(() => {
		if (!needsContentLead || !showHeadings) return;
		const timer = setTimeout(() => (contentLeadElapsed = true), 80);
		return () => clearTimeout(timer);
	});
	let slowSetup = $state(false);
	let slowResults = $state(false);
	$effect(() => {
		if (setup.resolved) return;
		const timer = setTimeout(() => (slowSetup = true), 2_000);
		return () => clearTimeout(timer);
	});
	const results = loadModule(
		() => getContracts() ?? loadContracts(),
		() => true
	);
	const Contracts = $derived(results.module ?? getContracts());
	let fallbackSearch = $state('');
	let fallbackQuery = $state('');
	const search = $derived(searchState?.value ?? fallbackSearch);
	const query = $derived(searchState?.query ?? fallbackQuery);
	$effect(() => {
		void search;
		if (!showContent) return;
		slowResults = false;
		const timer = setTimeout(() => (slowResults = true), 2_000);
		return () => clearTimeout(timer);
	});
	let searchInput = $state<HTMLInputElement | null>();
	let resultsReady = $state(false);
	const settled = $derived(search.trim() === query);
	const searchLabel = $derived(
		buyerLinksAvailable !== false ? 'Search contracts and buyer links' : 'Search contracts'
	);
	const canCreateContract = $derived(
		session.workspaceAdmitted &&
			!session.blocked &&
			!session.closing &&
			Boolean(
				viewer().membership &&
				viewer().company &&
				viewer().templateReady &&
				viewer().instructionsReady
			)
	);
	$effect(() => {
		if (searchState) return;
		const value = fallbackSearch.trim();
		const timer = setTimeout(() => (fallbackQuery = value), 200);
		return () => clearTimeout(timer);
	});
	$effect(() => {
		if (searchInput) searchState?.restoreFocus(searchInput);
	});
	function updateSearch(value: string) {
		if (searchState) searchState.value = value;
		else fallbackSearch = value;
	}
	function prepareCreation() {
		if (canCreateContract && resultsReady && !navigating.to)
			destinations?.prepare('/contracts/new');
	}
	function handleTyping(event: KeyboardEvent) {
		if (
			!searchInput ||
			event.defaultPrevented ||
			event.isComposing ||
			event.ctrlKey ||
			event.metaKey ||
			event.altKey ||
			event.key.length !== 1 ||
			event.key === ' '
		)
			return;
		const target = event.target;
		if (
			target instanceof HTMLElement &&
			(target.isContentEditable ||
				target.closest(
					'input, textarea, select, [role="textbox"], [role="combobox"], [role="listbox"], [role="menu"]'
				))
		)
			return;
		event.preventDefault();
		searchInput.value = (searchInput.value + event.key).slice(0, searchInput.maxLength);
		searchInput.focus({ preventScroll: true });
		searchInput.dispatchEvent(new Event('input', { bubbles: true }));
	}
	onMount(() => {
		recordStartup('home-mounted');
		recordStartup('contracts-admitted');
		return interactions.shortcut(handleTyping);
	});
</script>

<ContractsLayout role={viewer().membership.role}>
	{#snippet toolbar()}
		{#if searchState}
			<SearchField
				bind:element={searchInput}
				label={searchLabel}
				placeholder="Search by name of company"
				maxlength={200}
				bind:value={searchState.value}
			/>
		{:else}
			<SearchField
				bind:element={searchInput}
				label={searchLabel}
				placeholder="Search by name of company"
				maxlength={200}
				bind:value={fallbackSearch}
			/>
		{/if}
		<Button
			href={canCreateContract ? resolve('/contracts/new') : undefined}
			disabled={!canCreateContract}
			onpointerenter={prepareCreation}
			onpointerdown={prepareCreation}
			onfocus={prepareCreation}
			title={canCreateContract
				? undefined
				: viewer().templateReady
					? 'An admin must add instructions to your company’s template.'
					: 'An admin must set up your company’s template.'}
		>
			<PlusIcon class="size-[15px]" aria-hidden="true" />New contract
		</Button>
	{/snippet}
	{#snippet children()}
		{#if setup.progress}<CompanySetupPrompt />{/if}
		{#if !setup.resolved && slowSetup}
			<p class="mb-5 text-xs text-ink-muted" role="status">Checking company setup…</p>
		{:else if setup.error}
			<p class="mb-5 text-xs text-ink-muted" role="alert">
				We couldn’t check company setup. <button
					class="cursor-pointer underline"
					onclick={setup.retry}>Try again</button
				>
			</p>
		{/if}
		{#if Contracts}
			<Contracts
				{search}
				{query}
				{settled}
				{buyerLinksAvailable}
				{showFirstLinkHint}
				{onFirstLinkCardReady}
				{firstVisit}
				{showHeadings}
				{showContent}
				{slowResults}
				onSearch={updateSearch}
				bind:ready={resultsReady}
			/>
		{:else}
			<ContractsCachedResults
				{search}
				{buyerLinksAvailable}
				{showFirstLinkHint}
				{onFirstLinkCardReady}
				{firstVisit}
				{showHeadings}
				{showContent}
				{slowResults}
				role={viewer().membership.role}
				failed={results.failed}
				onRetry={() => results.retry()}
			/>
		{/if}
	{/snippet}
</ContractsLayout>
