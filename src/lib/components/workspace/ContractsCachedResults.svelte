<script lang="ts">
	import type { Role } from '../../../convex/permissions';
	import type { SavedContractCard } from '$lib/contract/card';
	import type { Action } from 'svelte/action';
	import { useConvexClient } from 'convex-svelte';
	import { getContractSnapshotCache } from '$lib/contract/snapshot-cache';
	import { useWorkspaceReadSnapshots } from '$lib/auth/workspace-read-snapshots.svelte';
	import { recordStartup } from '$lib/auth/startup-perf';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import ContractCard from '$lib/components/contracts/ContractCard.svelte';
	import BuyerLinks from './BuyerLinks.svelte';
	import ContractGrid from './ContractGrid.svelte';
	import ContractsResultsLayout from './ContractsResultsLayout.svelte';
	import Button from '$lib/ui/Button.svelte';
	import LoadingWheel from '$lib/ui/LoadingWheel.svelte';
	import { orderBuyerLinks } from './buyer-link-order';

	let {
		search,
		buyerLinksAvailable,
		showFirstLinkHint = false,
		onFirstLinkCardReady,
		role,
		firstVisit = false,
		showHeadings = true,
		showContent = true,
		failed = false,
		onRetry
	}: {
		search: string;
		buyerLinksAvailable: boolean | undefined;
		showFirstLinkHint?: boolean;
		onFirstLinkCardReady?: () => void;
		role: Role;
		firstVisit?: boolean;
		showHeadings?: boolean;
		showContent?: boolean;
		failed?: boolean;
		onRetry?: () => void;
	} = $props();
	const reads = useWorkspaceReadSnapshots();
	const cache = getContractSnapshotCache(useConvexClient());
	const observe: Action<HTMLElement, SavedContractCard> = () => {};
	const words = $derived(search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean));
	const matches = (title: string) => {
		const normalized = title.toLocaleLowerCase();
		return words.every((word) => normalized.includes(word));
	};
	const contractDirectory = $derived(reads?.getDirectory('contracts'));
	const firstContracts = $derived(reads?.get('contracts'));
	const cards = $derived(
		(contractDirectory?.rows ?? firstContracts?.rows ?? []).filter(
			(card) => !cache.isDeleted(card._id) && matches(card.title)
		)
	);
	const buyerDirectory = $derived(reads?.getDirectory('buyerLinks'));
	const initialBuyerReady = Boolean(
		reads?.getDirectory('buyerLinks')?.rows.length || reads?.get('buyerLinks')?.rows.length
	);
	const firstBuyerLinks = $derived(reads?.get('buyerLinks'));
	const buyerRows = $derived.by(() => {
		const rows = (buyerDirectory?.rows ?? firstBuyerLinks?.rows ?? []).filter((row) =>
			matches(row.title)
		);
		return orderBuyerLinks(rows, !search.trim());
	});
	const showBuyerLinks = $derived(
		buyerLinksAvailable === true || (buyerLinksAvailable === undefined && buyerRows.length > 0)
	);
	let gridWidth = $state(0);
	let visibleRows = $state(4);
	const columns = $derived(gridWidth >= 1000 ? 3 : gridWidth >= 600 ? 2 : 1);
	const visibleLimit = $derived(visibleRows * columns);
	let visibleBuyerLinks = $state(10);
	$effect(() => {
		void search;
		visibleRows = 4;
		visibleBuyerLinks = 10;
	});
	let recorded = false;
	$effect(() => {
		if (!cards.length || recorded) return;
		recorded = true;
		recordStartup('contracts-local-cards-ready');
	});
</script>

<WorkspacePresentationReporter
	outcome={showContent && cards.length ? 'success' : failed ? 'error' : 'pending'}
/>

<ContractsResultsLayout
	{role}
	{firstVisit}
	buyerContentReadyInitially={initialBuyerReady}
	{showHeadings}
	{showContent}
	hasBuyerLinks={showBuyerLinks}
>
	{#snippet notice()}
		{#if failed}
			<p class="mb-3 text-xs text-ink-muted" role="alert">
				We couldn’t load your contracts. <button class="cursor-pointer underline" onclick={onRetry}
					>Try again</button
				>
			</p>
		{/if}
	{/snippet}
	{#snippet contracts()}
		{#if cards.length}
			<div class="@container" bind:clientWidth={gridWidth}>
				<ContractGrid>
					{#each cards.slice(0, visibleLimit) as contract (contract._id)}
						<ContractCard
							{contract}
							metadataCurrent={false}
							{observe}
							onWarm={() => {}}
							onCool={() => {}}
						/>
					{/each}
				</ContractGrid>
				{#if cards.length > visibleLimit}
					<Button
						variant="secondary"
						class="mt-3 w-full rounded-xl shadow-card"
						onclick={() => (visibleRows += 4)}
					>
						Show more
					</Button>
				{/if}
			</div>
		{:else}
			{#if search.trim()}
				<div class="flex min-h-40 items-center justify-center">
					<LoadingWheel class="size-5" label="Loading contract results" />
				</div>
			{/if}
		{/if}
	{/snippet}
	{#snippet buyerLinksContent(showBuyerContent)}
		{#if showBuyerLinks}
			{#if buyerRows.length}
				<BuyerLinks
					{role}
					showFirstLinkHint={showFirstLinkHint && !search.trim()}
					onFirstLinkCardReady={!search.trim() ? onFirstLinkCardReady : undefined}
					showContent={showBuyerContent}
					links={buyerRows.slice(0, visibleBuyerLinks)}
					unreadCurrent={false}
					hasMore={buyerRows.length > visibleBuyerLinks}
					loading={false}
					error={false}
					onShowMore={() => (visibleBuyerLinks += 3)}
					onRetry={() => {}}
				/>
			{:else}
				<BuyerLinks
					{role}
					showFirstLinkHint={showFirstLinkHint && !search.trim()}
					onFirstLinkCardReady={!search.trim() ? onFirstLinkCardReady : undefined}
					showContent={showBuyerContent}
					links={[]}
					loading={false}
					error={false}
					hasMore={false}
					onShowMore={() => {}}
					onRetry={() => {}}
				/>
			{/if}
		{/if}
	{/snippet}
</ContractsResultsLayout>
