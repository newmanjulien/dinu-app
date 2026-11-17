<script lang="ts">
	import { untrack } from 'svelte';
	import BuyerContractPage from '../../../src/lib/buyer/BuyerContractPage.svelte';
	import { setBuyerContract, type BuyerContract } from '../../../src/lib/buyer/contract.svelte';

	let { contract }: { contract: BuyerContract } = $props();
	setBuyerContract(untrack(() => contract));
</script>

<BuyerContractPage />
