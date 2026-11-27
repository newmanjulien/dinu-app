<script lang="ts">
	import ContractCardLayout from './ContractCardLayout.svelte';
	import CopyBuyerLink from '$lib/buyer/CopyBuyerLink.svelte';
	import LinkActivity from '$lib/buyer/LinkActivity.svelte';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import type { SaveStatus } from '$lib/contract/editors.svelte';
	import type { SavedContractCard } from '$lib/contract/card';
	import { workBlockMessage } from '$lib/contract/work-policy';
	import type { Action } from 'svelte/action';
	let {
		contract,
		metadataCurrent = true,
		status,
		observe,
		onWarm,
		onCool
	}: {
		contract: SavedContractCard;
		metadataCurrent?: boolean;
		status?: SaveStatus;
		observe: Action<HTMLElement, SavedContractCard>;
		onWarm: () => void;
		onCool: () => void;
	} = $props();
	const workBlock = $derived(
		contract.workBlock !== undefined
			? contract.workBlock
			: contract.hubspot?.availability === 'unavailable'
				? 'deal-unavailable'
				: null
	);
	const unread = $derived(metadataCurrent && contract.hasUnreadComment);
	const buyerLinkToken = $derived(metadataCurrent ? contract.buyerLinkToken : undefined);
	const hasActivity = $derived(Boolean(buyerLinkToken));
	const date = $derived(
		new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(
			contract._creationTime
		)
	);
</script>

<ContractCardLayout {contract} {unread} {hasActivity} {observe} {onWarm} {onCool}>
	{#snippet content()}
		<div class="flex min-w-0 items-center gap-2">
			<h2
				class="min-w-0 truncate text-[13px] leading-5 font-normal"
				title={`${contract.title} contract`}
			>
				{contract.title} contract
			</h2>
			{#if unread}
				<span
					class="inline-flex shrink-0 items-center gap-1.5 rounded-full border-hairline border-edge bg-surface px-2 py-0.5 text-[11px] leading-4 font-normal text-ink"
				>
					<span aria-hidden="true" class="size-1.5 rounded-full bg-emerald-400"></span>
					Unread
				</span>
			{/if}
		</div>
		<div class="flex min-w-0 items-center gap-2 text-xs text-ink-muted">
			<Avatar
				name={contract.creator.name}
				avatarUrl={contract.creator.avatarUrl}
				class="size-5"
				decorative
			/>
			<p class="min-w-0 truncate" title={`Created by ${contract.creator.name}`}>
				Created by {contract.creator.name}
			</p>
		</div>
		{#if status}<p class="text-xs text-ink-muted" role="status">{status}</p>{/if}
		<p class="text-xs text-ink-muted">
			Created <time datetime={new Date(contract._creationTime).toISOString()}>{date}</time>
		</p>
	{/snippet}
	{#snippet action()}
		{#if hasActivity}
			<LinkActivity id={contract._id} />
		{/if}
		<CopyBuyerLink
			id={contract._id}
			token={buyerLinkToken}
			reason={!buyerLinkToken && metadataCurrent && workBlock ? workBlockMessage(workBlock) : null}
		/>
	{/snippet}
</ContractCardLayout>
