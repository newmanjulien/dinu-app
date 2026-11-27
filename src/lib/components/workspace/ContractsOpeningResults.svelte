<script lang="ts">
	import type { Role } from '../../../convex/permissions';
	import type { SavedContractCard } from '$lib/contract/card';
	import type { Action } from 'svelte/action';
	import { useConvexClient } from 'convex-svelte';
	import { getContractSnapshotCache } from '$lib/contract/snapshot-cache';
	import { useWorkspaceLists } from '$lib/auth/workspace-lists.svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { useStartupHome } from '$lib/auth/startup-data';
	import { recordStartup } from '$lib/auth/startup-perf';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import ContractCard from '$lib/components/contracts/ContractCard.svelte';
	import ContractGrid, { contractGridColumns } from './ContractGrid.svelte';
	import ContractsResultsLayout from './ContractsResultsLayout.svelte';
	import Button from '$lib/ui/Button.svelte';
	import { homePage, matchingHomeRows } from './home-page';

	let {
		search,
		role,
		showContent = true,
		failed = false,
		onRetry
	}: {
		search: string;
		role: Role;
		showContent?: boolean;
		failed?: boolean;
		onRetry?: () => void;
	} = $props();
	const { home } = useWorkspaceLists();
	const viewer = useViewer();
	const session = useViewerSession();
	const startup = useStartupHome();
	const cache = getContractSnapshotCache(useConvexClient());
	const observe: Action<HTMLElement, SavedContractCard> = () => {};
	const requestedQuery = $derived(search.trim());
	const admitted = $derived(
		session.workspaceAdmitted && !session.blocked && !session.closing && !viewer().company.deletion
	);
	const firstPage = $derived(
		admitted ? homePage(home, startup(), viewer(), session.userId) : undefined
	);
	const cards = $derived(
		matchingHomeRows(firstPage?.page ?? [], requestedQuery).filter(
			(card) => !cache.isDeleted(card._id)
		)
	);
	const current = $derived(admitted && !requestedQuery && home.currentData !== undefined);
	const resultsLoading = $derived(showContent && !failed && !cards.length);
	let gridWidth = $state(0);
	let visibleRows = $state(4);
	const columns = $derived(contractGridColumns(gridWidth));
	const visibleLimit = $derived(visibleRows * columns);
	$effect(() => {
		void search;
		visibleRows = 4;
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

<ContractsResultsLayout {role} {showContent} loading={resultsLoading}>
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
							metadataCurrent={current}
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
		{:else if !current && !failed}
			<p class="text-xs text-ink-muted" role="status">
				{requestedQuery ? 'Loading search results…' : 'Loading contracts…'}
			</p>
		{/if}
	{/snippet}
</ContractsResultsLayout>
