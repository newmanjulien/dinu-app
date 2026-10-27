<script lang="ts">
	import '$lib/styles/contract-card-grid.css';
	import { navigating } from '$app/state';
	import { onDestroy, onMount, untrack } from 'svelte';
	import type { SavedContractCard } from '$lib/contract/card';
	import { afterStartupPaint, recordStartup } from '$lib/auth/startup-perf';
	import { useStartupData } from '$lib/auth/startup-data';
	import { useWorkspaceReadiness } from '$lib/auth/workspace-readiness.svelte';
	import { createVisibleContractWarming } from '$lib/contract/visible-contracts.svelte';
	import { getContractSnapshotCache } from '$lib/contract/snapshot-cache';
	import { useConvexClient, usePaginatedQuery } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import ContractCard from '$lib/components/contracts/ContractCard.svelte';
	import CompanyNameDialog from '$lib/components/ui/modal/CompanyNameDialog.svelte';
	import type { Id } from '../../../convex/_generated/dataModel';
	import { saveError } from '$lib/contract/saved';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { getContractSessions } from '$lib/contract/sessions.svelte';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
	import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import LoadingWheel from '$lib/ui/LoadingWheel.svelte';
	import { fieldShellClass, fieldInputClass } from '$lib/ui/field-styles';
	import Button from '$lib/ui/Button.svelte';
	import HomeSkeleton from './HomeSkeleton.svelte';
	import { getInteractionController, setInteractionOwner } from '$lib/components/ui/interactions';
	setInteractionOwner(Symbol('home'));
	const interactions = getInteractionController();
	const client = useConvexClient();
	const cache = getContractSnapshotCache(client);
	const saves = getContractSessions();
	const session = useViewerSession();
	const viewer = useViewer();
	const membershipId = viewer().membership.id;
	const startup = useStartupData();
	const readiness = useWorkspaceReadiness();
	let alive = true;
	onDestroy(() => {
		alive = false;
	});
	const warming = createVisibleContractWarming();
	onDestroy(() => warming.destroy());
	let search = $state('');
	let searchInput = $state<HTMLInputElement>();
	let query = $state('');
	let renaming = $state<{ id: Id<'savedContracts'>; companyName: string } | null>(null);
	let renameError = $state<string | null>(null);
	let actionError = $state<string | null>(null);
	let busy = $state(false);
	let deleting = $state<Id<'savedContracts'> | null>(null);
	const contracts = usePaginatedQuery(
		api.savedContracts.browse,
		() => ({
			membershipId,
			search: query,
			directoryReady: viewer().company.contractDirectoryReady ?? false
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
		if (!session.admitted || !hasPage) return;
		return afterStartupPaint(() => {
			readiness.painted = true;
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
			if (page)
				page = {
					...page,
					cards: page.cards.map((card) =>
						card._id === id ? { ...card, companyName: name, savedAt: Date.now() } : card
					)
				};
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

<main
	class="home min-h-[calc(100dvh-var(--app-header-height))] bg-page px-3 py-4 sm:px-4 md:px-5 md:py-5"
>
	<div class="mx-auto max-w-[1800px]">
		<div class="mb-6 flex items-center gap-2">
			<div class={`${fieldShellClass} flex h-9 flex-1 items-center gap-2`}>
				<MagnifyingGlassIcon size={17} aria-hidden="true" class="shrink-0 text-ink-muted" />
				<input
					bind:this={searchInput}
					type="search"
					aria-label="Search contracts"
					placeholder="Search by name of company"
					maxlength="200"
					bind:value={search}
					class={fieldInputClass}
				/>
				{#if search}
					<button
						type="button"
						aria-label="Clear search"
						class="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-button-sm text-ink-muted transition-colors hover:bg-control-fill hover:text-ink focus-visible:outline-1 focus-visible:outline-line-strong/40"
						onclick={() => {
							search = '';
							searchInput?.focus();
						}}
					>
						<XIcon size={14} weight="regular" aria-hidden="true" />
					</button>
				{/if}
			</div>
			<Button
				href={viewer().templateReady ? '/contracts/new' : undefined}
				disabled={!viewer().templateReady}
				title={viewer().templateReady
					? undefined
					: 'An admin must upload your company’s baseline contract.'}
				><PlusIcon size={15} aria-hidden="true" />Add New</Button
			>
		</div>
		{#if !viewer().templateReady}<p class="mb-5 text-[13px] text-ink-muted">
				Your company needs a baseline contract. <a class="underline text-accent" href="/admin"
					>Set up contract</a
				>
			</p>{/if}
		<div class="mb-3 flex items-center gap-3">
			<h1 class="text-sm font-medium">Contracts</h1>
			{#if list.waiting && list.cards.length}<LoadingWheel label="Refreshing contracts" />{/if}
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
			<div class="state" role="alert">
				<p>We couldn’t load your contracts.</p>
				<Button variant="secondary" onclick={() => window.location.reload()} class="mt-4"
					>Try again</Button
				>
			</div>
		{:else if list.waiting && list.cards.length === 0}
			<HomeSkeleton cardsOnly />
		{:else if list.empty}
			<div class="state" role="status">
				{#if list.query}<h2 class="text-[13px] font-medium">No contracts found</h2>
					<p class="mt-2 text-[13px] text-ink-muted">No company names match “{list.query}”.</p>
					<button onclick={() => (search = '')} class="mt-4 text-[13px] underline"
						>Clear search</button
					>
				{:else}<h2 class="text-[13.5px] font-medium">
						{viewer().templateReady ? 'No contracts yet' : 'No baseline contract'}
					</h2>
					<p class="mt-2 text-[13px] text-ink-muted">
						{viewer().templateReady
							? 'Select Add New to start your first contract.'
							: viewer().profile.role === 'admin'
								? 'This is where reps create contracts for customers. But first, you need to set up your company’s baseline contract.'
								: 'This is where reps create contracts for customers. But first, an admin needs to set up your company’s baseline contract.'}
					</p>{/if}
			</div>
		{:else if list.cards.length}
			<div class="contract-card-grid">
				{#each list.cards as contract (contract._id)}
					<ContractCard
						status={saves.statusFor(contract._id)}
						{contract}
						observe={warming.observe}
						onWarm={() => warming.warm(contract._id)}
						onCool={() => warming.cool(contract._id)}
						deleting={deleting === contract._id}
						onRename={() => {
							renaming = { id: contract._id, companyName: contract.companyName };
							renameError = null;
						}}
						onDelete={() => void remove(contract._id, contract.companyName)}
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
	</div>
</main>
{#if renaming}<CompanyNameDialog
		title="Rename contract"
		initialName={renaming.companyName}
		submitLabel="Rename"
		{busy}
		error={renameError}
		onSubmit={(name) => void rename(name)}
		onClose={() => (renaming = null)}
	/>{/if}

<style>
	.state {
		border: var(--surface-border-width) solid var(--color-edge);
		border-radius: var(--radius-base);
		background: var(--color-surface);
		box-shadow: var(--shadow-card);
		padding: 36px 20px;
		font-size: 14px;
		text-align: center;
	}
</style>
