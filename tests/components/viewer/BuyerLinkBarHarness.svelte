<script lang="ts">
	import BuyerLinkBar from '../../../src/lib/buyer/BuyerLinkBar.svelte';
	import { setViewer, type Viewer } from '../../../src/lib/auth/viewer-session.svelte';
	import {
		setContractEditors,
		type ContractEditors
	} from '../../../src/lib/contract/editors.svelte';
	import { setBuyerLinkCopyFeedback } from '../../../src/lib/buyer/copy-feedback.svelte';
	import type { useReadQuery } from '../../../src/lib/auth/read-query.svelte';
	import { api } from '../../../src/convex/_generated/api';
	import type { Id } from '../../../src/convex/_generated/dataModel';

	let {
		latest
	}: {
		latest: ReturnType<typeof useReadQuery<typeof api.buyerLinks.latest>>;
	} = $props();
	setViewer(() => ({ membership: { id: 'member-a' } }) as Viewer);
	setContractEditors({} as ContractEditors);
	setBuyerLinkCopyFeedback();
</script>

<BuyerLinkBar id={'contract-a' as Id<'savedContracts'>} {latest} />
