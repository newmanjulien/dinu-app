<script lang="ts">
	import { useWorkspaceLists } from '$lib/auth/workspace-lists.svelte';
	import ContractsResultsLayout from './ContractsResultsLayout.svelte';
	import { navigating } from '$app/state';
	import { onDestroy, untrack } from 'svelte';
	import { afterStartupPaint, recordStartup } from '$lib/auth/startup-perf';
	import { useStartupHome } from '$lib/auth/startup-data';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { createVisibleContractWarming } from '$lib/contract/visible-contracts.svelte';
	import { getContractSnapshotCache } from '$lib/contract/snapshot-cache';
	import { useConvexClient, usePaginatedQuery } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import ContractCard from '$lib/components/contracts/ContractCard.svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { getWorkspaceFeedback } from '$lib/components/chrome/workspace-feedback.svelte';
	import Button from '$lib/ui/Button.svelte';
	import ContractGrid, { contractGridColumns } from './ContractGrid.svelte';
	import { useContractsSearch } from './contracts-search.svelte';
	import { homePage, matchingHomeRows } from './home-page';

	const client = useConvexClient();
	const cache = getContractSnapshotCache(client);
	const feedback = getWorkspaceFeedback();
	const session = useViewerSession();
	const viewer = useViewer();
	const { home } = useWorkspaceLists();
	let {
		search,
		query,
		settled,
		showContent = true,
		onSearch,
		ready = $bindable(false)
	}: {
		search: string;
		query: string;
		settled: boolean;
		showContent?: boolean;
		onSearch: (value: string) => void;
		ready?: boolean;
	} = $props();
	const contractsSearch = useContractsSearch();
	const viewState = contractsSearch?.current;
	let viewQuery = untrack(() => query);
	if (viewState && viewState.viewQuery !== viewQuery) {
		viewState.viewQuery = viewQuery;
		viewState.contractRows = 4;
	}
	const admin = $derived(viewer().membership.role === 'admin');
	const canCreateContract = $derived(viewer().templateReady && viewer().instructionsReady);
	const membershipId = viewer().membership.id;
	const requestedQuery = $derived(search.trim());
	const admitted = $derived(
		session.workspaceAdmitted && !session.blocked && !session.closing && !viewer().company.deletion
	);
	const startup = useStartupHome();
	const warming = createVisibleContractWarming(viewer().company.id);
	onDestroy(() => warming.destroy());
	// The frame owns debounce. Admit the first read only after its current input settles;
	// subsequent typing keeps the last admitted read until the next settled term.
	let activeQuery = $state<string>();
	$effect(() => {
		if (settled) activeQuery = query;
	});
	let listRevision = $state(0);
	let expandedBrowse = $state(false);
	const contracts = usePaginatedQuery(
		api.contracts.browse,
		() => {
			void listRevision;
			void session.transportGeneration;
			return !admitted || activeQuery === undefined || (!activeQuery && !expandedBrowse)
				? 'skip'
				: { search: activeQuery };
		},
		{ initialNumItems: 24 }
	);
	const browsing = $derived(Boolean(activeQuery) || expandedBrowse);
	const browseCurrent = $derived(
		admitted &&
			browsing &&
			settled &&
			activeQuery === requestedQuery &&
			contracts.status !== 'LoadingFirstPage' &&
			!contracts.error
	);
	const current = $derived(
		browsing
			? browseCurrent
			: admitted && settled && requestedQuery === '' && home.currentData !== undefined
	);
	const firstPage = $derived(
		admitted ? homePage(home, startup(), viewer(), session.userId) : undefined
	);
	let listTimedOut = $state(false);
	const liveLoading = $derived(
		browsing
			? !contracts.error &&
					(contracts.status === 'LoadingFirstPage' || contracts.status === 'LoadingMore')
			: home.isLoading
	);
	$effect(() => {
		void query;
		void listRevision;
		void session.transportGeneration;
		const pending = liveLoading;
		untrack(() => (listTimedOut = false));
		if (!pending) return;
		const timer = setTimeout(() => (listTimedOut = true), 15_000);
		return () => clearTimeout(timer);
	});
	let firstLiveRecorded = false;
	$effect(() => {
		if (firstLiveRecorded || !current) return;
		firstLiveRecorded = true;
		recordStartup('contracts-first-live-page');
	});
	const list = $derived.by(() => {
		const error = listTimedOut || Boolean(browsing ? contracts.error : home.error);
		const rows = browseCurrent
			? contracts.results
			: matchingHomeRows(firstPage?.page ?? [], requestedQuery);
		const cards = admitted ? rows.filter((card) => !cache.isDeleted(card._id)) : [];
		const hasMore =
			current &&
			(browsing
				? contracts.status === 'CanLoadMore' || contracts.status === 'LoadingMore'
				: !firstPage!.isDone);
		return {
			cards,
			query: requestedQuery,
			error,
			waiting: !current,
			empty: current && cards.length === 0 && !hasMore && !error,
			hasMore,
			loadingMore: browsing && contracts.status === 'LoadingMore',
			canLoadMore: hasMore && !error && (!browsing || contracts.status === 'CanLoadMore'),
			pending: !current
		};
	});
	const cardMetadataCurrent = $derived(current);
	function retryList() {
		if (browsing) listRevision++;
		else home.retry();
	}
	let gridWidth = $state(0);
	let visibleRows = $state(viewState?.contractRows ?? 4);
	// Match the grid's container breakpoints, rather than the viewport width.
	const columns = $derived(contractGridColumns(gridWidth));
	const visibleLimit = $derived(visibleRows * columns);
	const visibleCards = $derived(list.cards.slice(0, visibleLimit));
	const hasHiddenCards = $derived(list.cards.length > visibleLimit);
	const resultsLoading = $derived(
		showContent && !list.cards.length && !list.error && (list.waiting || list.loadingMore)
	);
	$effect(() => {
		const current = query;
		if (current === viewQuery) return;
		viewQuery = current;
		visibleRows = 4;
		if (viewState) {
			viewState.viewQuery = current;
			viewState.contractRows = 4;
		}
	});
	function showMoreContracts() {
		visibleRows += 4;
		if (!requestedQuery && visibleRows * columns > 24 && firstPage && !firstPage.isDone)
			expandedBrowse = true;
		if (viewState) viewState.contractRows = visibleRows;
	}
	$effect(() => {
		// Reveal fetched cards first; request another page only to fill the visible rows.
		if (browsing && list.canLoadMore && list.cards.length < visibleLimit) contracts.loadMore(24);
	});
	$effect(() => {
		const pending = !showContent || list.pending || session.blocked || Boolean(navigating.to);
		untrack(() => {
			warming.searching(Boolean(requestedQuery));
			warming.pending(pending);
		});
	});
	const hasPage = $derived(list.cards.length > 0 || list.empty);
	$effect(() => {
		ready = hasPage && !list.pending;
	});
	$effect(() => {
		if (!session.workspaceAdmitted || !hasPage) return;
		return afterStartupPaint(() => {
			recordStartup('dashboard-painted');
		});
	});
</script>

<WorkspacePresentationReporter
	outcome={showContent && hasPage ? 'success' : list.error ? 'error' : 'pending'}
/>

<ContractsResultsLayout role={viewer().membership.role} {showContent} loading={resultsLoading}>
	{#snippet contracts()}
		<div bind:clientWidth={gridWidth}>
			{#if list.error && list.cards.length}<p class="mb-3 text-xs text-ink-muted" role="status">
					We couldn’t refresh your contracts. <button class="underline" onclick={retryList}
						>Try again</button
					>
				</p>{/if}
			{#if list.error && list.cards.length === 0}
				<div
					class="rounded-base border-hairline border-edge bg-surface px-5 py-9 text-center text-[14px] shadow-card"
					role="alert"
				>
					<p>We couldn’t load your contracts.</p>
					<Button variant="secondary" onclick={retryList} class="mt-4">Try again</Button>
				</div>
			{:else if list.empty}
				<div
					class="rounded-base border-hairline border-edge bg-surface px-5 py-9 text-center text-[14px] shadow-card"
					role="status"
				>
					{#if list.query}<h2 class="text-[13px] font-medium">No contracts found</h2>
						<p class="mt-2 text-[13px] text-ink-muted">No company names match “{list.query}”.</p>
						<button onclick={() => onSearch('')} class="mt-4 text-[13px] underline"
							>Clear search</button
						>
					{:else}<h2 class="text-[13.5px] font-medium">No contracts yet</h2>
						<p class="mt-2 text-[13px] text-ink-muted">
							{#if canCreateContract}
								Click New contract to start your first contract.
							{:else}
								{admin
									? 'Finish setting up your template to create your first contract.'
									: 'An admin needs to finish setting up your company’s template before you can create your first contract.'}
							{/if}
						</p>{/if}
				</div>
			{:else if list.cards.length}
				<ContractGrid>
					{#each visibleCards as contract (contract._id)}
						<ContractCard
							status={feedback.statusFor(contract._id)}
							{contract}
							metadataCurrent={cardMetadataCurrent}
							observe={warming.observe}
							onWarm={() => warming.warm(contract._id)}
							onCool={() => warming.cool(contract._id)}
						/>
					{/each}
				</ContractGrid>
			{:else if list.waiting}
				<p class="text-xs text-ink-muted" role="status">
					{list.query ? 'Loading search results…' : 'Loading contracts…'}
				</p>
			{/if}
			{#if hasHiddenCards || list.hasMore}
				<Button
					variant="secondary"
					class="mt-3 w-full rounded-xl shadow-card"
					disabled={list.error || list.loadingMore || (!hasHiddenCards && !list.canLoadMore)}
					onclick={showMoreContracts}>{list.loadingMore ? 'Loading…' : 'Show more'}</Button
				>
			{/if}
		</div>
	{/snippet}
</ContractsResultsLayout>
