<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import BuyerDocumentFrame from './BuyerDocumentFrame.svelte';
	import { getBuyerContract } from './contract.svelte';
	import { getBuyerSeller } from './seller.svelte';
	import BuyerDownloadFeedback from './BuyerDownloadFeedback.svelte';
	import BuyerUtilityRail from './BuyerUtilityRail.svelte';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	const contract = getBuyerContract();
	const seller = getBuyerSeller()!;
	let target: HTMLDivElement;
	onMount(() => contract.attach(target));
</script>

{#if seller.presentation === 'seller'}
	<div
		class="mt-2 mb-2 grid min-h-(--mobile-utility-rail-height) place-items-center px-2 text-center text-[13.5px] leading-6 text-ink-muted min-[1000px]:mt-5 min-[1000px]:mb-4 min-[1000px]:min-h-6"
	>
		{#if contract.displayed?.title}<h1>{contract.displayed.title}</h1>{:else}<SkeletonBlock
				class="h-3 w-52"
			/>{/if}
	</div>
{/if}
<BuyerUtilityRail />
<BuyerDownloadFeedback />
{#if contract.error}
	<p role="alert" class="p-12 text-center text-sm">
		{contract.error} <button class="underline" onclick={() => contract.retry()}>Retry</button>
	</p>
{:else if !contract.mountReady}
	<BuyerDocumentFrame loading />
{/if}
<div bind:this={target}>
	{#key contract.generation}
		{@const generation = contract.generation}
		<svelte:boundary onerror={() => untrack(() => contract.fail(generation, 'construction'))}>
			{#if contract.allowed && contract.mountReady && contract.Host && contract.content}
				<contract.Host {contract} />
			{/if}
			{#snippet failed()}{/snippet}
		</svelte:boundary>
	{/key}
</div>
