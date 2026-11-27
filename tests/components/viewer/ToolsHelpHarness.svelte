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
	import { HelpSession } from '../../../src/lib/components/ui/modal/help-session.svelte';
	import type { TemplateHelpVariant } from '../../../src/lib/components/ui/modal/help-content';
	let {
		state,
		workspace,
		variant = 'contract',
		buyer,
		download
	}: {
		state: CsmState;
		workspace: DocumentWorkspace;
		variant?: 'contract' | TemplateHelpVariant;
		buyer?: BuyerContract;
		download: () => void;
	} = $props();
	untrack(() => {
		if (buyer) setBuyerContract(buyer);
	});
	const client = useConvexClient();
	const contractHelp = new HelpSession();
	$effect(() => {
		if (buyer || variant !== 'contract') return;
		const identity = state.viewer.profile.id;
		const hidden = state.preferences.helpPreferences.contract;
		untrack(() =>
			contractHelp.configure({
				kind: 'preference',
				variant: 'contract',
				identity,
				hidden,
				save: (next) =>
					client.mutation(api.profiles.setHelpHidden, { variant: 'contract', hidden: next }),
				current: () => true
			})
		);
	});
	const connection = createReadQuery(client, api.hubspotConnections.status, {});
	const deals = new HubSpotDeals({
		client,
		membershipId: untrack(() => state.viewer.membership.id),
		connection,
		identity: () => 'fixture'
	});
	onDestroy(() => {
		contractHelp.destroy();
		deals.destroy();
	});
</script>

<SnappinessContext {state} {workspace} {deals}>
	{#if buyer}
		<BuyerUtilityRail />
		<DocumentTools
			helpReady={workspace.viewer.interactionEnabled}
			help={buyer.help}
			onTools={(tools) => buyer!.bindTools(buyer!.generation, tools)}
		/>
	{:else if variant === 'contract'}
		<WorkspaceChrome
			kind="saved"
			help={contractHelp}
			helpReady={false}
			settingsHref="/contracts/a/settings"
			onDownload={download}
			downloadReason="Preparing document"
		/>
	{:else}
		<WorkspaceChrome
			kind="template"
			helpVariant={variant}
			helpReady={false}
			downloadReason="Preparing document"
		/>
	{/if}
</SnappinessContext>
