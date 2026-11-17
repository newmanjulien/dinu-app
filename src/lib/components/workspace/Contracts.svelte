<script lang="ts">
	import { useWorkspaceReadSnapshots } from '$lib/auth/workspace-read-snapshots.svelte';
	import type { WorkspaceReadRows } from '$lib/auth/workspace-read-storage';
	import ContractsResultsLayout from './ContractsResultsLayout.svelte';
	import { useHubSpotDeals } from '$lib/hubspot-deals.svelte';
	import { navigating } from '$app/state';
	import { onDestroy, untrack } from 'svelte';
	import type { SavedContractCard } from '$lib/contract/card';
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
	import LoadingWheel from '$lib/ui/LoadingWheel.svelte';
	import ContractGrid from './ContractGrid.svelte';
	import BuyerLinks from './BuyerLinks.svelte';
	import { orderBuyerLinks } from './buyer-link-order';
	import { useContractsSearch } from './contracts-search.svelte';
	const client = useConvexClient();
	const cache = getContractSnapshotCache(client);
	const feedback = getWorkspaceFeedback();
	const session = useViewerSession();
	const viewer = useViewer();
	const reads = useWorkspaceReadSnapshots();
	const hubspot = useHubSpotDeals();
	let {
		search,
		query,
		settled,
		buyerLinksAvailable,
		showFirstLinkHint = false,
		onFirstLinkCardReady,
		firstVisit = false,
		showHeadings = true,
		showContent = true,
		onSearch,
		ready = $bindable(false)
	}: {
		search: string;
		query: string;
		settled: boolean;
		buyerLinksAvailable: boolean | undefined;
		showFirstLinkHint?: boolean;
		onFirstLinkCardReady?: () => void;
		firstVisit?: boolean;
		showHeadings?: boolean;
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
		viewState.buyerLinks = 10;
	}
	const admin = $derived(viewer().membership.role === 'admin');
	const canCreateContract = $derived(viewer().templateReady && viewer().instructionsReady);
	let visibilityState = $state<DocumentVisibilityState>();
	const visible = $derived(visibilityState !== undefined && visibilityState !== 'hidden');
	let warmedOwner: string | null = null;
	function warmDeals() {
		if (
			canCreateContract &&
			!list.pending &&
			contracts.status !== 'LoadingFirstPage' &&
			visible &&
			!session.blocked &&
			!navigating.to
		)
			hubspot.prefetch();
	}
	const membershipId = viewer().membership.id;
	const startup = useStartupHome();
	const warming = createVisibleContractWarming();
	onDestroy(() => warming.destroy());
	// The frame owns debounce. Admit the first read only after its current input settles;
	// subsequent typing keeps the last admitted read until the next settled term.
	let activeQuery = $state<string>();
	$effect(() => {
		if (settled) activeQuery = query;
	});
	let listRevision = $state(0);
	const contracts = usePaginatedQuery(
		api.contracts.browse,
		() => {
			void listRevision;
			return activeQuery === undefined ? 'skip' : { membershipId, search: activeQuery };
		},
		{ initialNumItems: 24 }
	);
	let buyerLinksRevision = $state(0);
	let visibleBuyerLinks = $state(viewState?.buyerLinks ?? 10);
	const buyerLinks = usePaginatedQuery(
		api.buyerLinks.browse,
		() => {
			void buyerLinksRevision;
			return activeQuery === undefined || buyerLinksAvailable === false
				? 'skip'
				: { membershipId, search: activeQuery };
		},
		{ initialNumItems: 10 }
	);
	type BuyerPage = {
		rows: WorkspaceReadRows['buyerLinks'];
		query: string;
		hasMore: boolean;
		source: 'snapshot' | 'live';
	};
	const rememberedBuyer = reads?.getBrowse(
		'buyerLinks',
		untrack(() => query)
	);
	let buyerPage = $state.raw<BuyerPage | undefined>(
		rememberedBuyer && untrack(() => search.trim() === query)
			? {
					rows: rememberedBuyer.rows,
					query: rememberedBuyer.query,
					hasMore: rememberedBuyer.hasMore,
					source: 'snapshot'
				}
			: undefined
	);
	let buyerPaged = false;
	let contractsPaged = false;
	$effect(() => {
		void activeQuery;
		contractsPaged = false;
		buyerPaged = false;
	});
	// Capture only unfiltered first pages for the default browsing snapshot.
	$effect(() => {
		if (buyerLinks.error) {
			return;
		}
		if (activeQuery === undefined || buyerLinks.status === 'LoadingFirstPage') return;
		const rows = buyerLinks.results;
		const currentQuery = activeQuery;
		const hasMore = buyerLinks.status !== 'Exhausted';
		const previous = untrack(() => buyerPage);
		if (
			previous?.source === 'snapshot' &&
			previous.query === currentQuery &&
			previous.rows.length > rows.length &&
			hasMore
		)
			return;
		untrack(() => {
			buyerPage = { rows, query: currentQuery, hasMore, source: 'live' };
			reads?.rememberBrowse('buyerLinks', currentQuery, rows, hasMore);
			if (!currentQuery && !buyerPaged) reads?.confirm('buyerLinks', rows, hasMore);
		});
	});
	const buyerSnapshot = $derived(!search.trim() && !query ? reads?.get('buyerLinks') : undefined);
	function matchesLocalSearch(title: string, term: string) {
		const words = term.toLocaleLowerCase().split(/\s+/).filter(Boolean);
		const normalized = title.toLocaleLowerCase();
		return words.every((word) => normalized.includes(word));
	}
	const buyerDirectory = $derived(reads?.getDirectory('buyerLinks'));
	const initialBuyerReady = Boolean(
		reads?.getDirectory('buyerLinks')?.rows.length ||
		reads?.getBrowse(
			'buyerLinks',
			untrack(() => query)
		)?.rows.length ||
		reads?.get('buyerLinks')?.rows.length
	);
	const localBuyerRows = $derived(
		buyerDirectory?.rows.filter((row) => matchesLocalSearch(row.title, search.trim()))
	);
	const partialBuyerRows = $derived(
		search.trim()
			? reads?.get('buyerLinks')?.rows.filter((row) => matchesLocalSearch(row.title, search.trim()))
			: undefined
	);
	const buyerLiveCurrent = $derived(
		buyerPage?.source === 'live' &&
			buyerPage.query === query &&
			activeQuery === query &&
			settled &&
			!buyerLinks.error &&
			buyerLinks.status !== 'LoadingFirstPage'
	);
	const buyerRows = $derived.by(() => {
		const rows = buyerLiveCurrent
			? (buyerPage?.rows ?? [])
			: (localBuyerRows ??
				(search.trim() === query && buyerPage?.query === query ? buyerPage.rows : undefined) ??
				partialBuyerRows ??
				buyerSnapshot?.rows ??
				[]);
		return buyerLiveCurrent && search.trim() ? rows : orderBuyerLinks(rows, !search.trim());
	});
	const buyerCurrent = $derived(Boolean(localBuyerRows) || buyerLiveCurrent);
	const showBuyerLinks = $derived(
		buyerLinksAvailable === true || (buyerLinksAvailable === undefined && buyerRows.length > 0)
	);
	function showMoreBuyerLinks() {
		visibleBuyerLinks += 3;
		if (viewState) viewState.buyerLinks = visibleBuyerLinks;
	}
	function loadMoreContracts() {
		contractsPaged = true;
		contracts.loadMore(24);
	}
	const hasMoreBuyerLinks = $derived(
		buyerRows.length > visibleBuyerLinks ||
			(buyerLiveCurrent
				? Boolean(buyerPage?.hasMore)
				: localBuyerRows === undefined
					? Boolean(buyerSnapshot?.hasMore)
					: false)
	);
	const buyerEmpty = $derived(buyerLiveCurrent && !buyerRows.length && !hasMoreBuyerLinks);
	$effect(() => {
		// Fill visible rows and catch up to the page retained from the last visit.
		const retainedCount =
			buyerPage?.source === 'snapshot' && buyerPage.query === activeQuery
				? buyerPage.rows.length
				: 0;
		const target = Math.max(visibleBuyerLinks, retainedCount);
		if (
			!(buyerCurrent || retainedCount) ||
			buyerLinks.status !== 'CanLoadMore' ||
			buyerLinks.results.length >= target
		)
			return;
		buyerPaged = true;
		buyerLinks.loadMore(
			Math.min(
				retainedCount > buyerLinks.results.length ? 10 : 3,
				target - buyerLinks.results.length
			)
		);
	});
	type ContractPage = {
		cards: SavedContractCard[];
		query: string;
		hasMore: boolean;
		source: 'startup' | 'live' | 'snapshot';
		changeVersion: number;
	};
	const rememberedBrowse = reads?.getBrowse(
		'contracts',
		untrack(() => query)
	);
	const remembered = reads?.get('contracts');
	let page = $state.raw<ContractPage | null>(
		rememberedBrowse && untrack(() => search.trim() === query)
			? {
					cards: rememberedBrowse.rows.filter((card) => !cache.isDeleted(card._id)),
					query: rememberedBrowse.query,
					hasMore: rememberedBrowse.hasMore,
					source: 'snapshot',
					changeVersion: reads?.localChangeVersion ?? 0
				}
			: remembered && untrack(() => !search && !query)
				? {
						cards: remembered.rows.filter((card) => !cache.isDeleted(card._id)),
						query: '',
						hasMore: remembered.hasMore,
						source: 'snapshot',
						changeVersion: reads?.localChangeVersion ?? 0
					}
				: null
	);
	let startupEligible = $state(true);
	const startupPage = $derived.by(() => {
		const value = startup();
		return startupEligible &&
			(reads?.allowsStartup ?? true) &&
			!search &&
			!query &&
			value?.scope.profileId === viewer().profile.id &&
			value.scope.membershipId === membershipId &&
			value.scope.companyId === viewer().company.id &&
			value.search === '' &&
			value.cursor === null &&
			value.numItems === 24
			? value.contracts
			: null;
	});
	$effect(() => {
		if (query || search || contracts.error || contracts.status !== 'LoadingFirstPage')
			startupEligible = false;
	});
	let listTimedOut = $state(false);
	const liveLoading = $derived(
		!contracts.error &&
			(contracts.status === 'LoadingFirstPage' || contracts.status === 'LoadingMore')
	);
	let firstLiveRecorded = false;
	$effect(() => {
		if (firstLiveRecorded || activeQuery === undefined || contracts.status === 'LoadingFirstPage')
			return;
		firstLiveRecorded = true;
		recordStartup(contracts.error ? 'contracts-first-live-error' : 'contracts-first-live-page');
	});
	let directorySyncStarted = false;
	$effect(() => {
		if (
			directorySyncStarted ||
			!showContent ||
			!reads ||
			!session.workspaceAdmitted ||
			session.blocked ||
			activeQuery === undefined ||
			contracts.error ||
			contracts.status === 'LoadingFirstPage'
		)
			return;
		return afterStartupPaint(() => {
			if (directorySyncStarted || session.blocked || session.closing) return;
			directorySyncStarted = true;
			void reads.syncDirectory(client);
		});
	});
	$effect(() => {
		// Each search and recovered transport receives a fresh read budget.
		void query;
		void listRevision;
		void session.transportGeneration;
		const pending = liveLoading;
		untrack(() => (listTimedOut = false));
		if (!pending) return;
		const timer = setTimeout(() => (listTimedOut = true), 15_000);
		return () => clearTimeout(timer);
	});
	$effect(() => {
		const initial = startupPage;
		if (initial && contracts.status === 'LoadingFirstPage') {
			untrack(() => {
				page = {
					cards: initial.page.filter((card) => !cache.isDeleted(card._id)),
					query: '',
					hasMore: !initial.isDone,
					source: 'startup',
					changeVersion: reads?.localChangeVersion ?? 0
				};
			});
			return;
		}
		if (contracts.error) {
			return;
		}
		if (activeQuery === undefined || contracts.status === 'LoadingFirstPage') {
			const snapshot = !search && !query ? reads?.get('contracts') : undefined;
			if (snapshot && !(page?.source === 'snapshot' && page.query === query))
				untrack(() => {
					page = {
						cards: snapshot.rows.filter((card) => !cache.isDeleted(card._id)),
						query: '',
						hasMore: snapshot.hasMore,
						source: 'snapshot',
						changeVersion: reads?.localChangeVersion ?? 0
					};
				});
			return;
		}
		const results = contracts.results;
		const currentQuery = activeQuery;
		const hasMore = contracts.status === 'CanLoadMore' || contracts.status === 'LoadingMore';
		const previous = untrack(() => page);
		if (
			previous?.source === 'snapshot' &&
			previous.query === currentQuery &&
			previous.cards.length > results.length &&
			hasMore
		)
			return;
		untrack(() => {
			if (!currentQuery && !contractsPaged) reads?.confirm('contracts', results, hasMore);
			reads?.rememberBrowse('contracts', currentQuery, results, hasMore);
			page = {
				cards: results.filter((card) => !cache.isDeleted(card._id)),
				query: currentQuery,
				hasMore,
				source: 'live',
				changeVersion: reads?.localChangeVersion ?? 0
			};
		});
	});
	$effect(() => {
		if (
			page?.source !== 'snapshot' ||
			page.query !== activeQuery ||
			contracts.error ||
			contracts.status !== 'CanLoadMore' ||
			contracts.results.length >= page.cards.length
		)
			return;
		loadMoreContracts();
	});
	const contractDirectory = $derived(reads?.getDirectory('contracts'));
	const localCards = $derived(
		contractDirectory?.rows.filter(
			(card) => !cache.isDeleted(card._id) && matchesLocalSearch(card.title, search.trim())
		)
	);
	const partialCards = $derived(
		search.trim()
			? reads
					?.get('contracts')
					?.rows.filter(
						(card) => !cache.isDeleted(card._id) && matchesLocalSearch(card.title, search.trim())
					)
			: undefined
	);
	const list = $derived.by(() => {
		const error = listTimedOut || Boolean(contracts.error);
		const currentQuery =
			settled &&
			activeQuery === query &&
			page?.query === query &&
			page?.source === 'live' &&
			page.changeVersion === (reads?.localChangeVersion ?? 0) &&
			contracts.status !== 'LoadingFirstPage' &&
			!contracts.error;
		const local = !currentQuery && localCards !== undefined;
		const cachedPage =
			settled &&
			page?.query === query &&
			page.source !== 'live' &&
			page.changeVersion === (reads?.localChangeVersion ?? 0) &&
			(page.cards.length > 0 || !page.hasMore);
		const cards = currentQuery
			? page!.cards
			: local
				? localCards
				: ((settled &&
					page?.query === query &&
					page.changeVersion === (reads?.localChangeVersion ?? 0)
						? page.cards
						: undefined) ??
					partialCards ??
					[]);
		const waiting =
			!currentQuery &&
			!cachedPage &&
			(!cards.length || !local) &&
			(!settled ||
				activeQuery === undefined ||
				activeQuery !== query ||
				(!error && (page?.query !== query || contracts.status === 'LoadingFirstPage')));
		const hasMore = Boolean(currentQuery && page?.hasMore);
		return {
			cards,
			query: search.trim(),
			error,
			waiting,
			empty: !cards.length && !hasMore && !waiting && (currentQuery || cachedPage) && !error,
			hasMore,
			loadingMore: hasMore && page?.source === 'live' && contracts.status === 'LoadingMore',
			canLoadMore:
				hasMore &&
				!waiting &&
				!error &&
				page?.source === 'live' &&
				contracts.status === 'CanLoadMore',
			pending: waiting || (!cards.length && error && !local)
		};
	});
	const cardMetadataCurrent = $derived(
		page?.source === 'live' &&
			contracts.status !== 'LoadingFirstPage' &&
			activeQuery === query &&
			settled
	);
	let gridWidth = $state(0);
	let visibleRows = $state(viewState?.contractRows ?? 4);
	// Match the grid's container breakpoints, rather than the viewport width.
	const columns = $derived(gridWidth >= 1000 ? 3 : gridWidth >= 600 ? 2 : 1);
	const visibleLimit = $derived(visibleRows * columns);
	const visibleCards = $derived(list.cards.slice(0, visibleLimit));
	const hasHiddenCards = $derived(list.cards.length > visibleLimit);
	$effect(() => {
		const current = query;
		if (current === viewQuery) return;
		viewQuery = current;
		visibleRows = 4;
		visibleBuyerLinks = 10;
		if (viewState) {
			viewState.viewQuery = current;
			viewState.contractRows = 4;
			viewState.buyerLinks = 10;
		}
	});
	function showMoreContracts() {
		visibleRows += 4;
		if (viewState) viewState.contractRows = visibleRows;
	}
	$effect(() => {
		// Reveal fetched cards first; request another page only to fill the visible rows.
		if (list.canLoadMore && list.cards.length < visibleLimit) loadMoreContracts();
	});
	$effect(() => {
		const pending =
			!showContent ||
			contracts.status === 'LoadingFirstPage' ||
			list.pending ||
			session.blocked ||
			Boolean(navigating.to);
		untrack(() => warming.pending(pending));
	});
	const hasPage = $derived(page !== null || Boolean(contractDirectory));
	$effect(() => {
		ready = hasPage && !list.pending;
	});
	$effect(() => {
		const owner = hubspot.identity;
		if (
			!owner ||
			!showContent ||
			!session.workspaceAdmitted ||
			!hasPage ||
			list.pending ||
			contracts.status === 'LoadingFirstPage' ||
			!canCreateContract ||
			!visible ||
			navigating.to
		)
			return;
		return afterStartupPaint(() => {
			if (warmedOwner === owner || hubspot.identity !== owner) return;
			warmedOwner = owner;
			warmDeals();
		});
	});
	$effect(() => {
		if (!session.workspaceAdmitted || !hasPage) return;
		return afterStartupPaint(() => {
			recordStartup('dashboard-painted');
		});
	});
</script>

<svelte:document bind:visibilityState />

<WorkspacePresentationReporter
	outcome={showContent && hasPage ? 'success' : list.error ? 'error' : 'pending'}
/>

<ContractsResultsLayout
	role={viewer().membership.role}
	hasBuyerLinks={showBuyerLinks}
	{firstVisit}
	buyerContentReadyInitially={initialBuyerReady}
	{showHeadings}
	{showContent}
>
	{#snippet notice()}
		{#if buyerLinksAvailable !== false && buyerLinks.error && !showBuyerLinks}
			<p role="alert" class="mb-3 text-xs text-ink-muted">
				We couldn’t load your buyer links. <button
					class="cursor-pointer underline"
					onclick={() => buyerLinksRevision++}>Try again</button
				>
			</p>
		{/if}
	{/snippet}
	{#snippet contracts()}
		<div bind:clientWidth={gridWidth}>
			{#if list.error && list.cards.length}<p class="mb-3 text-xs text-ink-muted" role="status">
					We couldn’t refresh your contracts. <button
						class="underline"
						onclick={() => listRevision++}>Try again</button
					>
				</p>{/if}
			{#if list.error && list.cards.length === 0}
				<div
					class="rounded-base border-hairline border-edge bg-surface px-5 py-9 text-center text-[14px] shadow-card"
					role="alert"
				>
					<p>We couldn’t load your contracts.</p>
					<Button variant="secondary" onclick={() => listRevision++} class="mt-4">Try again</Button>
				</div>
			{:else if list.waiting && list.cards.length === 0}
				{#if list.query}
					<div class="flex min-h-40 items-center justify-center">
						<LoadingWheel class="size-5" label="Loading contract results" />
					</div>
				{/if}
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
			{/if}
			{#if hasHiddenCards || list.hasMore}
				<Button
					variant="secondary"
					class="mt-3 w-full rounded-xl shadow-card"
					disabled={list.waiting ||
						list.error ||
						list.loadingMore ||
						(!hasHiddenCards && !list.canLoadMore)}
					onclick={showMoreContracts}>{list.loadingMore ? 'Loading…' : 'Show more'}</Button
				>
			{/if}
		</div>
	{/snippet}
	{#snippet buyerLinksContent(showBuyerContent)}
		{#if showBuyerLinks}
			<BuyerLinks
				role={viewer().membership.role}
				showFirstLinkHint={showFirstLinkHint && !search.trim()}
				onFirstLinkCardReady={!search.trim() ? onFirstLinkCardReady : undefined}
				showContent={showBuyerContent}
				links={buyerRows.slice(0, visibleBuyerLinks)}
				emptyMessage={buyerEmpty
					? search.trim()
						? `No buyer links match “${search.trim()}”.`
						: 'No buyer links yet.'
					: undefined}
				hasMore={hasMoreBuyerLinks}
				loading={buyerLinks.isLoading && buyerRows.length <= visibleBuyerLinks}
				unreadCurrent={buyerLiveCurrent}
				error={Boolean(buyerLinks.error)}
				onShowMore={showMoreBuyerLinks}
				onRetry={() => buyerLinksRevision++}
			/>
		{/if}
	{/snippet}
</ContractsResultsLayout>
