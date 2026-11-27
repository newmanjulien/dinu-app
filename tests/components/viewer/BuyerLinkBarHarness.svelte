<script lang="ts">
	import BuyerLinkBar from '../../../src/lib/buyer/BuyerLinkBar.svelte';
	import { setViewer, type Viewer } from '../../../src/lib/auth/viewer-session.svelte';
	import {
		setContractEditors,
		type ContractEditors
	} from '../../../src/lib/contract/editors.svelte';
	import { setBuyerLinkCopyFeedback } from '../../../src/lib/buyer/copy-feedback.svelte';
	import type { ContractBuyerLink } from '../../../src/lib/contract/saved';
	import type { Id } from '../../../src/convex/_generated/dataModel';

	let {
		state
	}: {
		state: {
			buyerLink: ContractBuyerLink | null | undefined;
			hasUnreadComment: boolean;
			mode: 'negotiate' | 'comments';
		};
	} = $props();
	setViewer(() => ({ membership: { id: 'member-a' } }) as Viewer);
	setContractEditors({} as ContractEditors);
	setBuyerLinkCopyFeedback();
</script>

<BuyerLinkBar
	id={'contract-a' as Id<'savedContracts'>}
	buyerLink={state.buyerLink}
	hasUnreadComment={state.hasUnreadComment}
	mode={state.mode}
	onModeChange={(next) => (state.mode = next)}
/>
