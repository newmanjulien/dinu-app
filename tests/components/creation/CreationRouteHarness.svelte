<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import {
		setContractEditors,
		type ContractEditors
	} from '../../../src/lib/contract/editors.svelte';
	import {
		setTemplateSource,
		TemplateSource
	} from '../../../src/lib/playbook/template-source.svelte';
	import { useConvexClient } from 'convex-svelte';
	import {
		setDocumentLayoutProfiles,
		type DocumentLayoutProfiles
	} from '../../../src/lib/document/runtime/layout-context.svelte';
	import { screen } from '../../support/navigation.svelte';
	import SnappinessContext from '../viewer/SnappinessContext.svelte';
	import ContractRoute from '../../../src/lib/components/workspace/ContractRoute.svelte';
	import RetainedViewer from '../../../src/lib/components/document/RetainedViewer.svelte';
	import type { DocumentResources } from '../../../src/lib/document/runtime/resources.svelte';
	import type { HubSpotDeals } from '../../../src/lib/hubspot-deals.svelte';
	import type { WorkspaceRuntime } from '../../../src/lib/auth/workspace-context.svelte';
	import type { CsmState } from '../../support/csm-state.svelte';
	let {
		state,
		resources,
		editors,
		runtime,
		profiles,
		deals
	}: {
		state: CsmState;
		resources?: DocumentResources;
		editors: ContractEditors;
		runtime: WorkspaceRuntime;
		profiles: DocumentLayoutProfiles;
		deals?: HubSpotDeals;
	} = $props();
	untrack(() => {
		setContractEditors(editors);
		setDocumentLayoutProfiles(profiles);
	});
	const source = setTemplateSource(
		new TemplateSource(
			useConvexClient(),
			untrack(() => state.viewer.membership.id)
		)
	);
	onDestroy(() => source.destroy());
</script>

<SnappinessContext {state} {resources} {runtime} {deals}>
	{#if !screen.home}<ContractRoute data={screen.destination} />{/if}
	{#if resources && runtime.hostReady}
		{#each resources.entries as entry (entry)}<RetainedViewer {entry} />{/each}
	{/if}
</SnappinessContext>
