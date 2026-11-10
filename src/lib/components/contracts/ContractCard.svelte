<script lang="ts">
	import LinkActivity from '$lib/buyer/LinkActivity.svelte';
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
	let hovered = false;
	let focused = false;
	const date = $derived(
		new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(
			contract._creationTime
		)
	);
</script>

<article
	use:observe={contract}
	class="relative flex min-w-0 flex-col rounded-xl border-hairline border-edge bg-surface shadow-card transition-colors hover:border-control-border"
>
	<a
		href={`/contracts/${contract._id}`}
		data-sveltekit-preload-data="off"
		onmouseenter={() => {
			hovered = true;
			onWarm();
		}}
		onfocus={() => {
			focused = true;
			onWarm();
		}}
		onmouseleave={() => {
			hovered = false;
			if (!focused) onCool();
		}}
		onblur={() => {
			focused = false;
			if (!hovered) onCool();
		}}
		class="flex flex-1 flex-col justify-between gap-1.5 rounded-xl py-[9px] pr-[80px] pl-[11px] outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-1 focus-visible:after:ring-accent"
		aria-label={`Open contract for ${contract.buyerCompanyName}`}
	>
		<h2
			class="min-w-0 truncate text-[13.5px] leading-5 font-medium"
			title={contract.buyerCompanyName}
		>
			{contract.buyerCompanyName}
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
	</a>
	<div class="absolute top-[9px] right-[11px] z-10 inline-flex items-center">
		<CopyBuyerLink id={contract._id} reason={workBlock ? workBlockMessage(workBlock) : null} />
		<LinkActivity id={contract._id} />
	</div>
</article>
