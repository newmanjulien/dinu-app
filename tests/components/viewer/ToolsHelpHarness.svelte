<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { useConvexClient } from 'convex-svelte';
	import { api } from '../../../src/convex/_generated/api';
	import { createReadQuery } from '../../../src/lib/auth/read-query.svelte';
	import { setBuyerContract, type BuyerContract } from '../../../src/lib/buyer/contract.svelte';
	import BuyerUtilityRail from '../../../src/lib/buyer/BuyerUtilityRail.svelte';
	import DocumentTools from '../../../src/lib/components/document/DocumentTools.svelte';
	import { HubSpotDeals } from '../../../src/lib/hubspot-deals.svelte';
	import type { CsmState } from '../../support/csm-state.svelte';
	import type { DocumentWorkspace } from '../../../src/lib/document/runtime/workspace-context';
	import SnappinessContext from './SnappinessContext.svelte';
	import WorkspaceChrome from '../../../src/lib/components/workspace/WorkspaceChrome.svelte';
	import type { HelpVariant } from '../../../src/lib/components/ui/modal/help-content';
	let {
		state,
		workspace,
		variant = 'rep',
		buyer,
		download
	}: {
		state: CsmState;
		workspace: DocumentWorkspace;
		variant?: Exclude<HelpVariant, 'buyer'>;
		buyer?: BuyerContract;
		download: () => void;
	} = $props();
	untrack(() => {
		if (buyer) setBuyerContract(buyer);
	});
	const connection = createReadQuery(useConvexClient(), api.hubspotConnections.status, {
		membershipId: untrack(() => state.viewer.membership.id)
	});
	const deals = new HubSpotDeals({
		client: useConvexClient(),
		membershipId: untrack(() => state.viewer.membership.id),
		connection,
		identity: () => 'fixture'
	});
	onDestroy(() => deals.destroy());
</script>

<SnappinessContext {state} {workspace} {deals}>
	{#if buyer}
		<BuyerUtilityRail />
		<DocumentTools
			helpVariant="buyer"
			helpReady={workspace.viewer.interactionEnabled}
			help={buyer.help}
			onTools={(tools) => buyer!.bindTools(buyer!.generation, tools)}
		/>
	{:else}
		<WorkspaceChrome
			helpVariant={variant}
			helpReady={false}
			settingsHref={variant === 'rep' ? '/contracts/a/settings' : undefined}
			onDownload={variant === 'rep' ? download : undefined}
			downloadReason="Preparing document"
		/>
	{/if}
</SnappinessContext>
