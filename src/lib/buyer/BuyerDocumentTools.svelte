<script lang="ts">
	import { getBuyerContract } from '$lib/buyer/contract.svelte';
	import DocumentTools from '$lib/components/document/DocumentTools.svelte';
	import { getDocumentWorkspace } from '$lib/document/runtime/workspace-context';
	import BuyerDownloadFeedback from './BuyerDownloadFeedback.svelte';
	import { onMount } from 'svelte';
	let { active }: { active: boolean } = $props();
	const { viewer } = getDocumentWorkspace();
	const contract = getBuyerContract();
	const download = contract.download;
	onMount(() => contract.registerTools());
</script>

<DocumentTools
	{active}
	helpVariant="buyer"
	helpReady={viewer.interactionEnabled}
	onDownload={() => {
		void download.start();
	}}
	downloadReason={download.reason}
/>
<BuyerDownloadFeedback />
