<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import BuyerDocumentFrame from './BuyerDocumentFrame.svelte';
	import { getBuyerContract } from './contract.svelte';
	import BuyerDownloadFeedback from './BuyerDownloadFeedback.svelte';
	import BuyerUtilityRail from './BuyerUtilityRail.svelte';
	import { afterPaint } from '$lib/document/runtime/scheduler';
	import { recordDocumentLoadingMilestone } from '$lib/document/runtime/render-perf';
	const contract = getBuyerContract();
	let target: HTMLDivElement;
	let helpPresented = $state(false);
	$effect(() => {
		if (!contract.help.admitted) {
			helpPresented = false;
			return;
		}
		if (helpPresented || !contract.headerPresented) return;
		if (!contract.help.open) {
			helpPresented = true;
			recordDocumentLoadingMilestone('help-document-admitted', {
				opening: contract.help.loadingOpening
			});
			return;
		}
		// Give automatic Help a paint opportunity before constructing document pages.
		const lifetime = new AbortController();
		void afterPaint(lifetime.signal)
			.then(() => {
				if (contract.allowed && contract.headerPresented && contract.help.admitted) {
					helpPresented = true;
					recordDocumentLoadingMilestone('help-document-admitted', {
						opening: contract.help.loadingOpening
					});
				}
			})
			.catch(() => {});
		return () => lifetime.abort();
	});
	onMount(() => contract.attach(target));
</script>

<BuyerUtilityRail />
<BuyerDownloadFeedback />
{#if contract.error}
	<p role="alert" class="p-12 text-center text-sm">
		{contract.error} <button class="underline" onclick={() => contract.retry()}>Retry</button>
	</p>
{:else if !contract.mountReady || !helpPresented}
	<BuyerDocumentFrame loading />
{/if}
<div bind:this={target}>
	{#key contract.generation}
		{@const generation = contract.generation}
		<svelte:boundary onerror={() => untrack(() => contract.fail(generation, 'construction'))}>
			{#if contract.allowed && helpPresented && contract.mountReady && contract.Host && contract.content}
				<contract.Host {contract} />
			{/if}
			{#snippet failed()}{/snippet}
		</svelte:boundary>
	{/key}
</div>
