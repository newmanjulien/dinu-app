<script lang="ts">
	import ContractsLayout from './ContractsLayout.svelte';
	import { resolve } from '$app/paths';
	import SearchField from '$lib/ui/SearchField.svelte';
	import { useHubSpotDeals } from '$lib/hubspot-deals.svelte';
	import { navigating } from '$app/state';
	import { onDestroy, onMount, untrack } from 'svelte';
	import type { SavedContractCard } from '$lib/contract/card';
	import { afterStartupPaint, recordStartup } from '$lib/auth/startup-perf';
	import { useStartupHome } from '$lib/auth/startup-data';
	import { useWorkspaceHints } from '$lib/auth/workspace-hints.svelte';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { createVisibleContractWarming } from '$lib/contract/visible-contracts.svelte';
	import { getContractSnapshotCache } from '$lib/contract/snapshot-cache';
	import { useConvexClient, usePaginatedQuery } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import ContractCard from '$lib/components/contracts/ContractCard.svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { getWorkspaceFeedback } from '$lib/components/chrome/workspace-feedback.svelte';
	import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
	import LoadingWheel from '$lib/ui/LoadingWheel.svelte';
	import Button from '$lib/ui/Button.svelte';
	import CompanySetupPrompt from '$lib/features/company-setup/CompanySetupPrompt.svelte';
	import ContractGrid from './ContractGrid.svelte';
	import ContractGridSkeleton from './ContractGridSkeleton.svelte';
	import BuyerLinks from './BuyerLinks.svelte';
	import BuyerLinksSkeleton from './BuyerLinksSkeleton.svelte';
	import { getInteractionController, setInteractionOwner } from '$lib/components/ui/interactions';
	setInteractionOwner(Symbol('contracts'));
	const interactions = getInteractionController();
	const client = useConvexClient();
	const cache = getContractSnapshotCache(client);
	const feedback = getWorkspaceFeedback();
	const session = useViewerSession();
	const viewer = useViewer();
	const hints = useWorkspaceHints();
	const hubspot = useHubSpotDeals();
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
	const companyId = viewer().company.id;
	const startup = useStartupHome();
	const warming = createVisibleContractWarming();
	onDestroy(() => warming.destroy());
	let search = $state('');
	let searchInput = $state<HTMLInputElement | null>();
	let query = $state('');
	let listRevision = $state(0);
	const contracts = usePaginatedQuery(
		api.contracts.browse,
		() => {
			void listRevision;
			return { membershipId, search: query };
		},
		{ initialNumItems: 24 }
	);
	let buyerLinksRevision = $state(0);
	let visibleBuyerLinks = $state(10);
	const buyerLinks = usePaginatedQuery(
		api.buyerLinks.browse,
		() => {
			void buyerLinksRevision;
			return { membershipId };
		},
		{ initialNumItems: 10, keepPreviousData: true }
	);
	const hasBuyerLinks = $derived(buyerLinks.results.length > 0);
	const buyerLinksPresence = $derived(
		hasBuyerLinks
			? true
			: !buyerLinks.error && buyerLinks.status === 'Exhausted'
				? false
				: undefined
	);
	const showBuyerLinksSkeleton = $derived(
		buyerLinksPresence === undefined && !buyerLinks.error && hints.hasBuyerLinks === true
	);
	$effect(() => {
		const present = buyerLinksPresence;
		if (present === undefined || buyerLinks.error || session.blocked || session.closing) return;
		untrack(() => hints.rememberBuyerLinks({ membershipId, companyId }, present));
	});
	const hasMoreBuyerLinks = $derived(
		buyerLinks.results.length > visibleBuyerLinks ||
			buyerLinks.status === 'CanLoadMore' ||
			buyerLinks.status === 'LoadingMore'
	);
	$effect(() => {
		// Fill the visible rows even when deleted contracts leave an empty page.
		if (
			!buyerLinks.error &&
			buyerLinks.status === 'CanLoadMore' &&
			buyerLinks.results.length < visibleBuyerLinks
		)
			buyerLinks.loadMore(3);
	});
	type ContractPage = {
		cards: SavedContractCard[];
		query: string;
		hasMore: boolean;
		source: 'startup' | 'live';
	};
	let page = $state.raw<ContractPage | null>(null);
	let startupEligible = $state(true);
	const startupPage = $derived.by(() => {
		const value = startup();
		return startupEligible &&
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
	$effect(() => {
		const value = search.trim();
		const timer = setTimeout(() => (query = value), 200);
		return () => clearTimeout(timer);
	});
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
		return interactions.shortcut(handleTyping);
	});
	let listTimedOut = $state(false);
	const liveLoading = $derived(
		!contracts.error &&
			(contracts.status === 'LoadingFirstPage' || contracts.status === 'LoadingMore')
	);
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
					source: 'startup'
				};
			});
			return;
		}
		if (contracts.error) {
			untrack(() => (page = null));
			return;
		}
		if (contracts.status === 'LoadingFirstPage') return;
		const results = contracts.results;
		const currentQuery = query;
		const hasMore = contracts.status === 'CanLoadMore' || contracts.status === 'LoadingMore';
		untrack(() => {
			page = {
				cards: results.filter((card) => !cache.isDeleted(card._id)),
				query: currentQuery,
				hasMore,
				source: 'live'
			};
		});
	});
	const list = $derived.by(() => {
		const error = listTimedOut || Boolean(contracts.error);
		const currentQuery = search.trim() === query && page?.query === query;
		const waiting =
			search.trim() !== query ||
			(!error &&
				(page?.query !== query ||
					(contracts.status === 'LoadingFirstPage' &&
						!(page?.source === 'startup' && startupPage))));
		const hasMore = Boolean(currentQuery && page?.hasMore);
		return {
			cards: page?.cards ?? [],
			query: page?.query ?? '',
			error,
			waiting,
			empty: Boolean(page && !page.cards.length && !page.hasMore && !waiting && !error),
			hasMore,
			loadingMore: hasMore && page?.source === 'live' && contracts.status === 'LoadingMore',
			canLoadMore:
				hasMore &&
				!waiting &&
				!error &&
				page?.source === 'live' &&
				contracts.status === 'CanLoadMore',
			pending: liveLoading || waiting || error
		};
	});
	let gridWidth = $state(0);
	let visibleRows = $state(4);
	// Match the grid's container breakpoints, rather than the viewport width.
	const columns = $derived(gridWidth >= 1000 ? 4 : gridWidth >= 600 ? 2 : 1);
	const visibleLimit = $derived(visibleRows * columns);
	const visibleCards = $derived(list.cards.slice(0, visibleLimit));
	const hasHiddenCards = $derived(list.cards.length > visibleLimit);
	$effect(() => {
		void query;
		visibleRows = 4;
	});
	$effect(() => {
		// Reveal fetched cards first; request another page only to fill the visible rows.
		if (list.canLoadMore && list.cards.length < visibleLimit) contracts.loadMore(24);
	});
	$effect(() => {
		const pending = list.pending || session.blocked || Boolean(navigating.to);
		untrack(() => warming.pending(pending));
	});
	const hasPage = $derived(page !== null);
	$effect(() => {
		const owner = hubspot.identity;
		if (
			!owner ||
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

<WorkspacePresentationReporter outcome={hasPage ? 'success' : list.error ? 'error' : 'pending'} />

<ContractsLayout
	role={viewer().membership.role}
	hasBuyerLinks={hasBuyerLinks || showBuyerLinksSkeleton}
>
	{#snippet toolbar()}
		<SearchField
			bind:element={searchInput}
			label="Search contracts"
			placeholder="Search by name of company"
			maxlength={200}
			bind:value={search}
		/>
		<Button
			href={canCreateContract ? resolve('/contracts/new') : undefined}
			disabled={!canCreateContract}
			onpointerenter={warmDeals}
			onpointerdown={warmDeals}
			onfocus={warmDeals}
			title={canCreateContract
				? undefined
				: viewer().templateReady
					? 'An admin must add instructions to your company’s template.'
					: 'An admin must set up your company’s template.'}
			><PlusIcon class="size-[15px]" aria-hidden="true" />New contract</Button
		>
	{/snippet}
	{#snippet notice()}
		<CompanySetupPrompt />
		{#if buyerLinks.error && !hasBuyerLinks}
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
			{#if list.waiting && list.cards.length}
				<div class="mb-3 flex items-center">
					<LoadingWheel label="Refreshing contracts" class="size-5" />
				</div>
			{/if}
			{#if list.error && list.cards.length}<p class="mb-3 text-xs text-ink-muted" role="status">
					We couldn’t refresh your contracts. Showing previous results. <button
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
				<ContractGridSkeleton />
			{:else if list.empty}
				<div
					class="rounded-base border-hairline border-edge bg-surface px-5 py-9 text-center text-[14px] shadow-card"
					role="status"
				>
					{#if list.query}<h2 class="text-[13px] font-medium">No contracts found</h2>
						<p class="mt-2 text-[13px] text-ink-muted">No company names match “{list.query}”.</p>
						<button onclick={() => (search = '')} class="mt-4 text-[13px] underline"
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
					onclick={() => (visibleRows += 4)}>{list.loadingMore ? 'Loading…' : 'Show more'}</Button
				>
			{/if}
		</div>
	{/snippet}
	{#snippet buyerLinksContent()}
		{#if hasBuyerLinks}
			<BuyerLinks
				role={viewer().membership.role}
				links={buyerLinks.results.slice(0, visibleBuyerLinks)}
				hasMore={hasMoreBuyerLinks}
				loading={buyerLinks.isLoading}
				error={Boolean(buyerLinks.error)}
				onShowMore={() => (visibleBuyerLinks += 3)}
				onRetry={() => buyerLinksRevision++}
			/>
		{:else if showBuyerLinksSkeleton}
			<BuyerLinksSkeleton />
		{/if}
	{/snippet}
</ContractsLayout>
