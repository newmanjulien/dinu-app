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
	let receivedPage = $state(false);
	const initialPage = $derived.by(() => {
		const value = startup();
		return !receivedPage &&
			!search &&
			!query &&
			value?.viewer?.profile.id === viewer().profile.id &&
			value.viewer.membership?.id === membershipId
			? value.contracts
			: null;
	});
	$effect(() => {
		if (query || search || contracts.error || contracts.status !== 'LoadingFirstPage')
			receivedPage = true;
	});
	$effect(() => {
		const value = search.trim();
		const timer = setTimeout(() => (query = value), 200);
		return () => clearTimeout(timer);
	});
	const pendingSearch = $derived(search.trim() !== query);
	let retained = $state.raw<SavedContractCard[]>([]);
	let settledQuery = $state<string | null>(null);
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
	const listLoading = $derived(Boolean(contracts.isLoading && !contracts.error));
	const listError = $derived(listTimedOut || Boolean(contracts.error));
	$effect(() => {
		// Each search and recovered transport receives a fresh read budget.
		void query;
		void session.transportGeneration;
		const pending = listLoading;
		untrack(() => (listTimedOut = false));
		if (!pending) return;
		const timer = setTimeout(() => (listTimedOut = true), 15_000);
		return () => clearTimeout(timer);
	});
	const waiting = $derived(
		pendingSearch ||
			Boolean(
				!listError &&
				!initialPage &&
				((contracts.isLoading && contracts.status !== 'LoadingMore') || settledQuery !== query)
			)
	);
	const cards = $derived(retained);
	$effect(() => {
		const initial = initialPage;
		if (initial && contracts.status === 'LoadingFirstPage') {
			untrack(() => {
				retained = initial.page.filter((card) => !cache.isDeleted(card._id));
				settledQuery = '';
			});
			return;
		}
		if ((contracts.isLoading && contracts.status !== 'LoadingMore') || contracts.error) return;
		const results = contracts.results;
		const currentQuery = query;
		untrack(() => {
			retained = results.filter((card) => !cache.isDeleted(card._id));
			settledQuery = currentQuery;
		});
	});
	$effect(() => {
		const pending =
			Boolean(contracts.isLoading) ||
			waiting ||
			listError ||
			session.blocked ||
			Boolean(navigating.to);
		untrack(() => warming.pending(pending));
	});
	let firstResult = $state(false);
	$effect(() => {
		const ready = Boolean(initialPage || (!listError && contracts.status !== 'LoadingFirstPage'));
		if (ready) firstResult = true;
	});
	$effect(() => {
		if (!session.admitted || !firstResult) return;
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
			retained = retained.map((card) =>
				card._id === id ? { ...card, companyName: name, savedAt: Date.now() } : card
			);
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
			retained = retained.filter((card) => card._id !== id);
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
			<div
				class="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-button-lg border border-[#e5e5e5] bg-white px-3 text-[#8a8a8a] transition-colors focus-within:border-[#d5d5d5]"
			>
				<MagnifyingGlassIcon size={17} aria-hidden="true" />
				<input
					bind:this={searchInput}
					type="search"
					aria-label="Search contracts"
					placeholder="Search by name of company"
					maxlength="200"
					bind:value={search}
					class="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-ink outline-none placeholder:text-[#8a8a8a] [&::-webkit-search-cancel-button]:hidden"
				/>
				{#if search}
					<button
						type="button"
						aria-label="Clear search"
						class="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-button-sm text-[#8a8a8a] transition-colors hover:bg-[#f3f3f3] hover:text-ink focus-visible:outline-1 focus-visible:outline-[#d5d5d5]"
						onclick={() => {
							search = '';
							searchInput?.focus();
						}}
					>
						<XIcon size={14} weight="regular" aria-hidden="true" />
					</button>
				{/if}
			</div>
			{#if viewer().templateReady}<a
					href="/contracts/new"
					class="flex h-[38px] shrink-0 items-center gap-1.5 rounded-button-lg bg-[#171717] px-3.5 py-2 text-[12.5px] font-normal text-white hover:bg-[#303030]"
					><PlusIcon size={15} aria-hidden="true" />Add New</a
				>
			{:else}<button
					disabled
					title="An admin must upload your company’s baseline contract."
					class="flex h-[38px] shrink-0 items-center gap-1.5 rounded-button-lg bg-[#171717] px-3.5 py-2 text-[12.5px] font-normal text-white opacity-40"
					><PlusIcon size={15} aria-hidden="true" />Add New</button
				>{/if}
		</div>
		{#if !viewer().templateReady}<p class="mb-5 text-[13px] text-ink-muted">
				Your company needs a baseline contract. <a class="underline text-accent" href="/admin"
					>Set up contract</a
				>
			</p>{/if}
		<div class="mb-3 flex items-center gap-3">
			<h1 class="text-sm font-medium">Contracts</h1>
			{#if waiting && cards.length}<LoadingWheel label="Refreshing contracts" />{/if}
		</div>
		{#if listError && cards.length}<p class="mb-3 text-xs text-ink-muted" role="status">
				We couldn’t refresh your contracts. Showing previous results.
			</p>{/if}
		{#if actionError}<p
				class="mb-5 rounded-xl border border-danger/20 bg-danger-surface p-4 text-sm text-danger"
				role="alert"
			>
				{actionError}
			</p>{/if}
		{#if listError && cards.length === 0}
			<div class="state" role="alert">
				<p>We couldn’t load your contracts.</p>
				<button
					onclick={() => window.location.reload()}
					class="mt-4 rounded-button-lg border border-line bg-surface px-4 py-2 text-sm"
					>Try again</button
				>
			</div>
		{:else if waiting && cards.length === 0}
			<HomeSkeleton cardsOnly />
		{:else if cards.length === 0 && !waiting && (contracts.status === 'Exhausted' || initialPage?.isDone)}
			<div class="state" role="status">
				{#if query}<h2 class="text-[13px] font-medium">No contracts found</h2>
					<p class="mt-2 text-[13px] text-ink-muted">No company names match “{query}”.</p>
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
		{:else if cards.length}
			<div class="contract-card-grid">
				{#each cards as contract (contract._id)}
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
		{#if (cards.length || contracts.status === 'CanLoadMore' || contracts.status === 'LoadingMore') && contracts.status !== 'Exhausted'}<div
				class="mt-6 flex justify-center"
			>
				<button
					disabled={waiting ||
						listError ||
						contracts.status === 'LoadingFirstPage' ||
						contracts.status === 'LoadingMore'}
					onclick={() => contracts.loadMore(24)}
					class="rounded-button-lg border border-[#e5e5e5] bg-white px-4 py-2 text-sm disabled:opacity-50"
					>{contracts.status === 'LoadingMore' ? 'Loading…' : 'Load more'}</button
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
		border: 1px solid #e5e5e5;
		border-radius: var(--radius-base);
		background: white;
		padding: 36px 20px;
		font-size: 14px;
		text-align: center;
	}
</style>
