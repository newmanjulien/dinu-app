<script lang="ts">
	import BuyerLinkBarAdmission from '../../../src/lib/components/workspace/BuyerLinkBarAdmission.svelte';
	import type { DocumentWorkspace } from '../../../src/lib/document/runtime/workspace-context';
	import type { useReadQuery } from '../../../src/lib/auth/read-query.svelte';
	import type { BuyerLinkBarVisit } from '../../../src/lib/buyer/bar-visit.svelte';
	import { api } from '../../../src/convex/_generated/api';
	type State = {
		workspace: {
			source: { renderSource: object | null };
			viewer: { firstPagesReady: { source: object } | null };
		};
		latest: {
			data: { token: string } | null | undefined;
			error: Error | undefined;
			isLoading: boolean;
		};
		available: boolean;
		interactionAdmitted: boolean;
		visitShown: boolean;
	};
	let {
		state
	}: {
		state: State;
	} = $props();
	const visit = {
		get shown() {
			return state.visitShown;
		},
		claim() {
			state.visitShown = true;
		}
	} as unknown as BuyerLinkBarVisit;
</script>

<BuyerLinkBarAdmission
	id={'contract-a' as import('../../../src/convex/_generated/dataModel').Id<'savedContracts'>}
	{visit}
	latest={state.latest as ReturnType<typeof useReadQuery<typeof api.buyerLinks.latest>>}
	workspace={state.workspace as unknown as DocumentWorkspace}
	available={state.available}
	interactionAdmitted={state.interactionAdmitted}
/>
