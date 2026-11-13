<script lang="ts">
	import ContractGrid from './ContractGrid.svelte';
	import ContractCardLayout from '../contracts/ContractCardLayout.svelte';
	let { announce = true }: { announce?: boolean } = $props();
</script>

{#if announce}<span role="status" class="sr-only">Loading contracts</span>{/if}
<ContractGrid>
	{#each Array.from({ length: 16 }) as _, index (index)}<ContractCardLayout
			skeletonIndex={index}
		/>{/each}
</ContractGrid>
