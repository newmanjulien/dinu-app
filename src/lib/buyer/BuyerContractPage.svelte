<script lang="ts">
	import BuyerDocumentFrame from '$lib/buyer/BuyerDocumentFrame.svelte';
	import { getBuyerContract } from '$lib/buyer/contract.svelte';
	import BuyerDownloadFeedback from '$lib/buyer/BuyerDownloadFeedback.svelte';
	import UtilityRail from '$lib/components/chrome/UtilityRail.svelte';
	import { onMount } from 'svelte';
	const contract = getBuyerContract();
	const download = contract.download;
	let target: HTMLDivElement;
	onMount(() => contract.attach(target));
</script>

{#if !contract.hasTools}
	<UtilityRail
		onDownload={() => {
			void download.start();
		}}
		downloadReason={download.reason}
	/>
	{#if download.error}
		<div class="pt-[calc(var(--mobile-utility-rail-height)+16px)] min-[1000px]:pt-5">
			<BuyerDownloadFeedback />
		</div>
	{/if}
{/if}
{#if contract.error}
	<p role="alert" class="p-12 text-center text-sm">
		{contract.error} <button class="underline" onclick={() => contract.retry()}>Retry</button>
	</p>
{:else if !contract.mountReady}
	<BuyerDocumentFrame loading />
{/if}
<div bind:this={target}></div>
