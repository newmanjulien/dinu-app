<script lang="ts">
	import { useHubSpotDeals } from '$lib/hubspot-deals.svelte';
	import { navigating } from '$app/state';
	import { onDestroy, onMount, untrack } from 'svelte';
	import type { SavedContractCard } from '$lib/contract/card';
	import { afterStartupPaint, recordStartup } from '$lib/auth/startup-perf';
	import { useStartupData } from '$lib/auth/startup-data';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { createVisibleContractWarming } from '$lib/contract/visible-contracts.svelte';
	import { getContractSnapshotCache } from '$lib/contract/snapshot-cache';
	import { useConvexClient, usePaginatedQuery } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import ContractCard from '$lib/components/contracts/ContractCard.svelte';
	import CompanyNameDialog from '$lib/components/ui/modal/CompanyNameDialog.svelte';
	import type { Id } from '../../../convex/_generated/dataModel';
	import { saveError } from '$lib/contract/saved';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { getContractEditors } from '$lib/contract/editors.svelte';
	import { getWorkspaceFeedback } from '$lib/components/chrome/workspace-feedback.svelte';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
	import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import LoadingWheel from '$lib/ui/LoadingWheel.svelte';
	import Button from '$lib/ui/Button.svelte';
	import HelpHint from '$lib/ui/HelpHint.svelte';
	import CompanySetupPrompt from '$lib/features/company-setup/CompanySetupPrompt.svelte';
	import HomeSkeleton from './HomeSkeleton.svelte';
	import HomeSections from './HomeSections.svelte';
	import IntegrationCatalog from './IntegrationCatalog.svelte';
	import { getInteractionController, setInteractionOwner } from '$lib/components/ui/interactions';
	setInteractionOwner(Symbol('home'));
	const interactions = getInteractionController();
	const client = useConvexClient();
	const cache = getContractSnapshotCache(client);
	const saves = getContractEditors();
	const feedback = getWorkspaceFeedback();
	const session = useViewerSession();
	const viewer = useViewer();
	const hubspot = useHubSpotDeals();
	const admin = $derived(viewer().membership.role === 'admin');
	const canCreateContract = $derived(viewer().templateReady && viewer().instructionsReady);
	let visible = $state(false);
	let warmedOwner: string | null = null;
	onMount(() => {
		const visibility = () => (visible = document.visibilityState !== 'hidden');
		visibility();
		document.addEventListener('visibilitychange', visibility);
		return () => document.removeEventListener('visibilitychange', visibility);
	});
	function warmDeals() {
		if (canCreateContract && visible && !session.blocked && !navigating.to) hubspot.prefetch();
	}
	const membershipId = viewer().membership.id;
	const startup = useStartupData();
	let alive = true;
	onDestroy(() => {
		alive = false;
	});
	const warming = createVisibleContractWarming();
	onDestroy(() => warming.destroy());
	let search = $state('');
	let searchInput = $state<HTMLInputElement>();
	let query = $state('');
	let renaming = $state<{ id: Id<'savedContracts'>; buyerCompanyName: string } | null>(null);
	let renameError = $state<string | null>(null);
	let actionError = $state<string | null>(null);
	let busy = $state(false);
	let deleting = $state<Id<'savedContracts'> | null>(null);
	const contracts = usePaginatedQuery(
		api.contracts.browse,
		() => ({
			membershipId,
			search: query
		}),
		{ initialNumItems: 24 }
	);
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
			value?.viewer?.profile.id === viewer().profile.id &&
			value.viewer.membership?.id === membershipId
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
		recordStartup('usable');
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
		if (contracts.status === 'LoadingFirstPage' || contracts.error) return;
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
	async function rename(name: string) {
		if (!alive || session.blocked || !renaming || busy) return;
		const id = renaming.id;
		busy = true;
		renameError = null;
		try {
			await saves.rename(id, name);
			if (!alive) return;
			renaming = null;
		} catch (error) {
			if (alive) renameError = saveError(error, 'We couldn’t rename this contract. Try again.');
		} finally {
			if (alive) busy = false;
		}
	}
	async function remove(id: Id<'savedContracts'>, name: string) {
		if (!alive || session.blocked || deleting) return;
		if (
			!window.confirm(
				`Delete the contract for “${name}”? This permanently removes its saved choices and document snapshot.`
			)
		)
			return;
		deleting = id;
		actionError = null;
		try {
			await saves.remove(id);
			if (!alive) return;
			if (page) page = { ...page, cards: page.cards.filter((card) => card._id !== id) };
		} catch (error) {
			if (alive) actionError = saveError(error, 'We couldn’t delete this contract. Try again.');
		} finally {
			if (alive) deleting = null;
		}
	}
</script>

<WorkspacePresentationReporter outcome={hasPage ? 'success' : list.error ? 'error' : 'pending'} />

<main
	class="home min-h-[calc(100dvh-var(--app-header-height))] bg-page px-3 py-4 sm:px-4 md:px-5 md:py-5"
>
	<div class="mx-auto max-w-[1800px]">
		<div class="mb-6 flex items-center gap-2">
			<div
				class="w-full rounded-button-lg border-hairline border-edge bg-surface px-3 shadow-control outline-none transition-[background-color] focus-within:border-accent focus-within:outline-solid focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent/18 not-disabled:not-aria-disabled:[&:not([readonly])]:not-aria-invalid:hover:not-focus-within:bg-field-hover not-disabled:not-aria-disabled:aria-invalid:border-danger/30 not-disabled:not-aria-disabled:aria-invalid:bg-danger-surface not-disabled:not-aria-disabled:aria-invalid:text-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:border-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:outline-danger/18 motion-reduce:transition-none min-w-0 text-ink aria-disabled:bg-canvas aria-disabled:text-ink-muted flex h-9 flex-1 items-center gap-2"
			>
				<MagnifyingGlassIcon aria-hidden="true" class="size-[17px] shrink-0 text-ink-muted" />
				<input
					bind:this={searchInput}
					type="search"
					aria-label="Search contracts"
					placeholder="Search by name of company"
					maxlength="200"
					bind:value={search}
					class="min-w-0 text-[13px] placeholder:font-[350] placeholder:text-ink-muted w-full flex-1 border-0 bg-transparent p-0 text-inherit outline-none [&::-webkit-search-cancel-button]:hidden"
				/>
				{#if search}
					<button
						type="button"
						aria-label="Clear search"
						class="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-button-sm text-ink-muted transition-colors hover:bg-control-hover hover:text-ink focus-visible:outline-1 focus-visible:outline-line-strong/40"
						onclick={() => {
							search = '';
							searchInput?.focus();
						}}
					>
						<XIcon class="size-[15px]" weight="regular" aria-hidden="true" />
					</button>
				{/if}
			</div>
			<Button
				href={canCreateContract ? '/contracts/new' : undefined}
				disabled={!canCreateContract}
				onpointerenter={warmDeals}
				onpointerdown={warmDeals}
				onfocus={warmDeals}
				title={canCreateContract
					? undefined
					: viewer().templateReady
						? 'An admin must add instructions to your contract.'
						: 'An admin must upload your company’s baseline contract.'}
				><PlusIcon class="size-[15px]" aria-hidden="true" />New contract</Button
			>
		</div>
		<CompanySetupPrompt />
		{#snippet integrationSidebar()}<IntegrationCatalog />{/snippet}
		<HomeSections sidebar={admin ? integrationSidebar : undefined}>
			<div class="mb-3 flex items-center gap-3">
				<div class="flex items-center gap-1.5">
					<h1 class="text-[13.5px] font-medium">Contracts</h1>
					<HelpHint id="contractsIntro" label="About contracts" />
				</div>
				{#if list.waiting && list.cards.length}<LoadingWheel
						label="Refreshing contracts"
						class="size-5"
					/>{/if}
			</div>
			{#if list.error && list.cards.length}<p class="mb-3 text-xs text-ink-muted" role="status">
					We couldn’t refresh your contracts. Showing previous results.
				</p>{/if}
			{#if actionError}<p
					class="mb-5 rounded-xl border-hairline border-danger/20 bg-danger-surface shadow-card p-4 text-sm text-danger"
					role="alert"
				>
					{actionError}
				</p>{/if}
			{#if list.error && list.cards.length === 0}
				<div
					class="rounded-base border-hairline border-edge bg-surface px-5 py-9 text-center text-[14px] shadow-card"
					role="alert"
				>
					<p>We couldn’t load your contracts.</p>
					<Button variant="secondary" onclick={() => window.location.reload()} class="mt-4"
						>Try again</Button
					>
				</div>
			{:else if list.waiting && list.cards.length === 0}
				<HomeSkeleton cardsOnly {admin} />
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
									? 'Finish company setup to create your first contract.'
									: 'An admin needs to finish company setup before you can create your first contract.'}
							{/if}
						</p>{/if}
				</div>
			{:else if list.cards.length}
				<div
					class={admin
						? 'grid grid-cols-1 gap-3 @[600px]:grid-cols-2 @[1000px]:grid-cols-4'
						: 'grid grid-cols-1 gap-3 min-[600px]:grid-cols-2 min-[1000px]:grid-cols-4'}
				>
					{#each list.cards as contract (contract._id)}
						<ContractCard
							status={feedback.statusFor(contract._id)}
							{contract}
							observe={warming.observe}
							onWarm={() => warming.warm(contract._id)}
							onCool={() => warming.cool(contract._id)}
							deleting={deleting === contract._id}
							onRename={() => {
								renaming = { id: contract._id, buyerCompanyName: contract.buyerCompanyName };
								renameError = null;
							}}
							onDelete={() => void remove(contract._id, contract.buyerCompanyName)}
						/>
					{/each}
				</div>
			{/if}
			{#if list.hasMore}<div class="mt-6 flex justify-center">
					<Button
						variant="secondary"
						disabled={!list.canLoadMore}
						onclick={() => contracts.loadMore(24)}
						>{list.loadingMore ? 'Loading…' : 'Load more'}</Button
					>
				</div>{/if}
		</HomeSections>
	</div>
</main>
{#if renaming}<CompanyNameDialog
		title="Rename contract"
		initialName={renaming.buyerCompanyName}
		submitLabel="Rename"
		{busy}
		error={renameError}
		onSubmit={(name) => void rename(name)}
		onClose={() => (renaming = null)}
	/>{/if}
