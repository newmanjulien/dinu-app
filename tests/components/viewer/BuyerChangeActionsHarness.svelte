<script lang="ts">
	import BuyerChangeActions from '../../../src/lib/buyer/BuyerChangeActions.svelte';
	import type { BuyerChangeReview } from '../../../src/lib/buyer/reviews.svelte';
	import type { DiscussionSession } from '../../../src/lib/discussions/session.svelte';

	let {
		state,
		review,
		session
	}: {
		state: {
			root: HTMLElement | null;
			layout: HTMLElement | null;
			ready: boolean;
		};
		review: BuyerChangeReview;
		session: DiscussionSession;
	} = $props();
</script>

<BuyerChangeActions
	{review}
	{session}
	root={state.root}
	layout={state.layout}
	renderRevision={1}
	domRevision={1}
	ready={state.ready}
/>
