<script lang="ts">
	import SnappinessContext from '../viewer/SnappinessContext.svelte';
	import ContractCreation from '../../../src/lib/components/workspace/ContractCreation.svelte';
	import type { DocumentResources } from '../../../src/lib/document/runtime/resources.svelte';
	import type { CsmState } from '../../support/csm-state.svelte';
	let {
		state: accountState,
		resources,
		onOpen
	}: {
		state: CsmState;
		resources: DocumentResources;
		onOpen: (id: string) => Promise<boolean>;
	} = $props();
	let creation: ContractCreation;
	let busy = $state(false);
</script>

<SnappinessContext state={accountState} {resources}>
	<ContractCreation
		bind:this={creation}
		bind:busy
		{onOpen}
		onCreate={() => {}}
		onPrepareSaved={() => () => {}}
	/>
	<button
		disabled={busy}
		onclick={() => creation.submit({ kind: 'manual', name: 'Synthetic Buyer' })}
		>Create contract</button
	>
</SnappinessContext>
