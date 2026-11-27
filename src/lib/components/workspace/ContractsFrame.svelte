<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { navigating } from '$app/state';
	import { loadModule } from '$lib/auth/component-loader.svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { getWorkspaceDestinations } from '$lib/auth/workspace-context.svelte';
	import { afterStartupPaint, recordStartup } from '$lib/auth/startup-perf';
	import { useCompanySetup } from '$lib/features/company-setup/company-setup.svelte';
	import CompanySetupPrompt from '$lib/features/company-setup/CompanySetupPrompt.svelte';
	import { getInteractionController, setInteractionOwner } from '$lib/components/ui/interactions';
	import SearchField from '$lib/ui/SearchField.svelte';
	import Button from '$lib/ui/Button.svelte';
	import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
	import ContractsLayout from './ContractsLayout.svelte';
	import ContractsOpeningResults from './ContractsOpeningResults.svelte';
	import { HOME_SEARCH_SETTLE_MS, useContractsSearch } from './contracts-search.svelte';
	import { getContracts, loadContracts } from './contracts';

	setInteractionOwner(Symbol('contracts'));
	const interactions = getInteractionController();
	const viewer = useViewer();
	const session = useViewerSession();
	const destinations = getWorkspaceDestinations();
	const contractsSearch = useContractsSearch();
	const searchState = $derived(contractsSearch?.current);
	const firstVisit = Boolean(contractsSearch && !contractsSearch.visited);
	const setup = useCompanySetup();
	// Let the admitted heading paint before revealing rows already in memory.
	let headingsPainted = $state(false);
	const showContent = $derived(!firstVisit || headingsPainted);
	$effect(() => {
		if (showContent && contractsSearch) contractsSearch.visited = true;
	});
	$effect(() => {
		if (!firstVisit) return;
		return afterStartupPaint(() => (headingsPainted = true));
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
	let searchInput = $state<HTMLInputElement | null>();
	let resultsReady = $state(false);
	const settled = $derived(search.trim() === query);
	const searchLabel = 'Search contracts';
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
		if (!value) {
			fallbackQuery = '';
			return;
		}
		const timer = setTimeout(() => (fallbackQuery = value), HOME_SEARCH_SETTLE_MS);
		return () => clearTimeout(timer);
	});
	function submitSearch(event: KeyboardEvent) {
		if (event.key !== 'Enter' || event.isComposing) return;
		if (searchState) searchState.query = searchState.value.trim();
		else fallbackQuery = fallbackSearch.trim();
	}
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
				onkeydown={submitSearch}
				label={searchLabel}
				placeholder="Search by name of company"
				maxlength={200}
				bind:value={searchState.value}
			/>
		{:else}
			<SearchField
				bind:element={searchInput}
				onkeydown={submitSearch}
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
		{#if setup.error}
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
				{showContent}
				onSearch={updateSearch}
				bind:ready={resultsReady}
			/>
		{:else}
			<ContractsOpeningResults
				{search}
				{showContent}
				role={viewer().membership.role}
				failed={results.failed}
				onRetry={() => results.retry()}
			/>
		{/if}
	{/snippet}
</ContractsLayout>
