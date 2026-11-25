<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import {
		TemplateSource,
		setTemplateSource
	} from '../../../src/lib/playbook/template-source.svelte';
	import { useConvexClient, useQuery } from 'convex-svelte';
	import { api } from '../../../src/convex/_generated/api';
	import { HubSpotDeals, setHubSpotDeals } from '../../../src/lib/hubspot-deals.svelte';
	import Layout from '../../../src/routes/(workspace)/contracts/(document)/+layout.svelte';
	import { ContractEditors, setContractEditors } from '../../../src/lib/contract/editors.svelte';
	import { setWorkspaceRuntime } from '../../../src/lib/auth/workspace-context.svelte';
	import { setViewerSession, setViewer } from '../../../src/lib/auth/viewer-session.svelte';
	import type { Viewer } from '../../../src/lib/auth/viewer-session.svelte';
	import { screen, goto } from '../../support/navigation.svelte';
	let { sessions }: { sessions: ContractEditors } = $props();
	untrack(() => setContractEditors(sessions));
	setWorkspaceRuntime({
		hostReady: true,
		paused: false,
		error: '',
		navigationIntent: 0,
		retry() {}
	});
	setViewerSession({
		userId: 'user',
		phase: 'ready',
		blocked: false,
		closing: false,
		transportGeneration: 0
	} as ReturnType<typeof import('../../../src/lib/auth/viewer-session.svelte').useViewerSession>);
	setViewer(
		() =>
			({
				profile: { id: 'profile' },
				helpPreferences: { contract: true, buyerLink: true },
				company: { id: 'company' },
				membership: { id: 'membership' }
			}) as Viewer
	);
	const hubspot = setHubSpotDeals(
		new HubSpotDeals({
			client: useConvexClient(),
			membershipId:
				'membership' as import('../../../src/convex/_generated/dataModel').Id<'memberships'>,
			connection: useQuery(api.hubspotConnections.status, {
				membershipId:
					'membership' as import('../../../src/convex/_generated/dataModel').Id<'memberships'>
			}),
			identity: () => 'session:company:membership'
		})
	);
	onDestroy(() => hubspot.destroy());
	const source = setTemplateSource(
		new TemplateSource(
			useConvexClient(),
			'membership' as import('../../../src/convex/_generated/dataModel').Id<'memberships'>
		)
	);
	onDestroy(() => source.destroy());
</script>

<button onclick={() => goto('/contracts')}>Contracts</button>
{#if screen.home}<main>Contracts content</main>{:else}<Layout
		data={{ workspaceHints: null, contractDestination: screen.destination }}
		>{#snippet children()}{/snippet}</Layout
	>{/if}
