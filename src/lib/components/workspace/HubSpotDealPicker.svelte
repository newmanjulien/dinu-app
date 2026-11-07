<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { useQuery } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import type { Id } from '../../../convex/_generated/dataModel';
	import InfoIcon from 'phosphor-svelte/lib/InfoIcon';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import { useHubSpotDeals, type DealPage } from '$lib/hubspot-deals.svelte';
	import Button from '$lib/ui/Button.svelte';
	import { saveError } from '$lib/contract/saved';
	let {
		selected = $bindable<{ id: string; name: string } | null>(null),
		pending = $bindable(true),
		selectionEligible = $bindable(false),
		contractId,
		disabled = false
	}: {
		selected?: { id: string; name: string } | null;
		pending?: boolean;
		selectionEligible?: boolean;
		contractId?: Id<'savedContracts'>;
		disabled?: boolean;
	} = $props();
	const resource = useHubSpotDeals();
	const connection = resource.connection;
	let search = $state('');
	let result = $state.raw<{ owner: string; term: string; page: DealPage }>();
	let attempt = $state.raw<{
		owner: string;
		term: string;
		busy: boolean;
		error: string | null;
	}>();
	const term = $derived(search.trim().slice(0, 200));
	const owner = $derived(resource.identity);
	const page = $derived(
		result?.owner === owner && result?.term === term
			? result.page
			: !term
				? resource.initialPage
				: undefined
	);
	const currentAttempt = $derived(
		attempt?.owner === owner && attempt?.term === term ? attempt : undefined
	);
	const busy = $derived(Boolean(owner && (!currentAttempt || currentAttempt.busy)));
	const error = $derived(currentAttempt?.error ?? null);
	const candidates = $derived(
		[...new Map((page?.deals ?? []).map((deal) => [deal.id, deal])).values()].slice(
			0,
			term ? 3 : 12
		)
	);
	const dealIds = $derived([
		...new Set([...candidates.map((deal) => deal.id), ...(selected ? [selected.id] : [])])
	]);
	const eligibility = useQuery(api.hubspotDeals.eligibility, () => {
		const current = connection.data;
		return owner && current?.accountId && current.installedAt !== null && dealIds.length
			? {
					membershipId: resource.options.membershipId,
					dealIds,
					accountId: current.accountId,
					installedAt: current.installedAt,
					requestIdentity: owner,
					...(contractId ? { contractId } : {})
				}
			: 'skip';
	});
	const eligibilityReady = $derived(
		Boolean(
			owner &&
			eligibility.data &&
			eligibility.data.requestIdentity === owner &&
			eligibility.data.accountId === connection.data?.accountId &&
			eligibility.data.installedAt === connection.data?.installedAt
		)
	);
	const eligibilityError = $derived(
		Boolean(owner && dealIds.length && (eligibility.error || eligibility.data === null))
	);
	const eligibilityLoading = $derived(
		Boolean(owner && dealIds.length && !eligibilityReady && !eligibilityError)
	);
	const linkedIds = $derived(new Set(eligibilityReady ? eligibility.data!.linkedDealIds : []));
	const available = $derived(candidates.filter((deal) => !linkedIds.has(deal.id)));
	const deals = $derived(term ? candidates : eligibilityReady ? available.slice(0, 3) : []);
	const hasMore = $derived(page?.hasMore ?? false);
	let generation = 0;
	let active = true;
	onDestroy(() => {
		active = false;
		generation++;
	});
	async function load(query: string, identity: string, force = false) {
		const current = ++generation;
		attempt = { owner: identity, term: query, busy: true, error: null };
		try {
			const page = await resource.load(query, force);
			if (!active || current !== generation || resource.identity !== identity || !page) return;
			result = { owner: identity, term: query, page };
		} catch (cause) {
			if (active && current === generation && resource.identity === identity)
				attempt = {
					owner: identity,
					term: query,
					busy: false,
					error: saveError(cause, 'We couldn’t load HubSpot deals. Try again.')
				};
		} finally {
			if (active && current === generation && attempt) attempt = { ...attempt, busy: false };
		}
	}
	$effect(() => {
		const query = term;
		const identity = owner;
		generation++;
		if (!identity) return;
		// Opening the picker and clearing search bypass the typing debounce.
		if (!query) {
			untrack(() => void load(query, identity));
			return;
		}
		const timer = setTimeout(() => void load(query, identity), 250);
		return () => clearTimeout(timer);
	});
	$effect(() => {
		void owner;
		untrack(() => {
			if (!disabled) selected = null;
		});
	});
	$effect(() => {
		pending = busy || eligibilityLoading;
		selectionEligible = Boolean(selected && eligibilityReady && !linkedIds.has(selected.id));
	});
	$effect(() => {
		// A frozen request may already have created the very ownership we are observing.
		if (!disabled && selected && eligibilityReady && linkedIds.has(selected.id)) selected = null;
	});
</script>

{#if owner}
	<div class="space-y-2">
		<label class="sr-only" for="hubspot-deal-search">HubSpot deal</label>
		{#if selected}
			<div
				class="flex items-center justify-between gap-3 rounded-button-lg border-hairline border-edge bg-surface p-3 text-[13px] shadow-control"
			>
				<span class="min-w-0 break-words">{selected.name}</span><Button
					variant="secondary"
					{disabled}
					onclick={() => (selected = null)}>Change</Button
				>
			</div>
		{:else}
			<input
				id="hubspot-deal-search"
				class="w-full rounded-button-lg border-hairline border-edge bg-surface px-3 shadow-control outline-none transition-[background-color] focus-within:border-accent focus-within:outline-solid focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent/18 not-disabled:not-aria-disabled:[&:not([readonly])]:not-aria-invalid:hover:not-focus-within:bg-field-hover not-disabled:not-aria-disabled:aria-invalid:border-danger/30 not-disabled:not-aria-disabled:aria-invalid:bg-danger-surface not-disabled:not-aria-disabled:aria-invalid:text-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:border-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:outline-danger/18 motion-reduce:transition-none min-w-0 text-[13px] placeholder:font-[350] placeholder:text-ink-muted text-ink disabled:bg-canvas disabled:text-ink-muted [&[readonly]]:bg-canvas [&[readonly]]:text-ink-muted h-9"
				type="search"
				placeholder="Search deals…"
				bind:value={search}
				{disabled}
			/>
			<div
				class="rounded-base border-hairline border-edge bg-surface p-1 shadow-control"
				aria-label="HubSpot deals"
				aria-busy={busy || eligibilityLoading}
			>
				{#each deals as deal (deal.id)}
					<div class="flex items-center gap-2 pr-2">
						<button
							type="button"
							class="block min-h-9 min-w-0 flex-1 cursor-pointer rounded-button-lg px-3 py-2 text-left text-[13px] break-words text-ink-secondary transition-colors not-disabled:hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:text-ink-muted motion-reduce:transition-none"
							disabled={disabled || !eligibilityReady || linkedIds.has(deal.id)}
							onclick={() => {
								if (!disabled && eligibilityReady && !linkedIds.has(deal.id)) selected = deal;
							}}>{deal.name}</button
						>
						{#if linkedIds.has(deal.id)}
							<Tooltip text="This deal is already linked to another contract.">
								{#snippet children()}
									<InfoIcon aria-hidden="true" class="size-4 text-ink-muted" />
								{/snippet}
							</Tooltip>
						{/if}
					</div>
				{/each}
				{#if !busy && !eligibilityLoading && !deals.length && !error && !eligibilityError}<p
						class="px-3 py-4 text-[13px] text-ink-muted"
					>
						{term
							? 'No deals found.'
							: 'No unlinked deals in the recent results. Search to find a deal.'}
					</p>{/if}
			</div>
			{#if !busy && eligibilityReady && !error && (hasMore || (!term && available.length > 3))}<p
					class="text-xs text-ink-muted"
				>
					{term
						? `Showing ${deals.length} ${deals.length === 1 ? 'match' : 'matches'}. Refine your search to find another deal.`
						: `Showing ${deals.length} recent unlinked ${deals.length === 1 ? 'deal' : 'deals'}. Search to find another deal.`}
				</p>{/if}
		{/if}
		{#if busy || eligibilityLoading}<p class="text-xs text-ink-muted" role="status">
				{busy
					? deals.length
						? 'Updating deals…'
						: 'Loading deals…'
					: 'Checking deal availability…'}
			</p>{/if}
		{#if eligibilityError}<p class="text-sm text-danger" role="alert">
				We couldn’t check which deals are already linked.
				<button type="button" class="underline" onclick={() => window.location.reload()}
					>Reload to try again</button
				>
			</p>{/if}
		{#if error}<p class="text-sm text-danger" role="alert">
				{error}
				<button
					type="button"
					class="underline"
					onclick={() => owner && void load(term, owner, true)}>Try again</button
				>
			</p>{/if}
	</div>
{:else}<p class="text-sm text-ink-muted">
		{connection.error
			? 'We couldn’t check HubSpot. Reconnect or reload to continue.'
			: !connection.data
				? 'Checking HubSpot…'
				: 'Ask an admin to connect or reconnect HubSpot before choosing a deal.'}
	</p>{/if}
