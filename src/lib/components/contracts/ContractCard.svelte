<script lang="ts">
	import ContractCardLayout from './ContractCardLayout.svelte';
	import CopyBuyerLink from '$lib/buyer/CopyBuyerLink.svelte';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import type { SaveStatus } from '$lib/contract/editors.svelte';
	import type { SavedContractCard } from '$lib/contract/card';
	import { workBlockMessage } from '$lib/contract/work-policy';
	import type { Action } from 'svelte/action';
	let {
		contract,
		status,
		observe,
		onWarm,
		onCool
	}: {
		contract: SavedContractCard;
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
	const date = $derived(
		new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(
			contract._creationTime
		)
	);
</script>

<ContractCardLayout {contract} {observe} {onWarm} {onCool}>
	{#snippet content()}
		<h2
			class="min-w-0 truncate text-[13px] leading-5 font-normal"
			title={`${contract.title} contract`}
		>
			{contract.title} contract
		</h2>
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
		<CopyBuyerLink id={contract._id} reason={workBlock ? workBlockMessage(workBlock) : null} />
	{/snippet}
</ContractCardLayout>
