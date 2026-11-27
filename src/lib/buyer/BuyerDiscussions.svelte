<script lang="ts">
	import { untrack } from 'svelte';
	import { useConvexClient } from 'convex-svelte';
	import { DiscussionSession } from '$lib/discussions/session.svelte';
	import { getBuyerSeller } from './seller.svelte';
	import { getBuyerContract, type BuyerDocumentContent } from './contract.svelte';

	let {
		content,
		token,
		active,
		prepare,
		onSession
	}: {
		content: BuyerDocumentContent;
		token: string;
		active: boolean;
		prepare: boolean;
		onSession: (session: DiscussionSession | undefined) => void;
	} = $props();
	const publicClient = useConvexClient();
	const publicContract = getBuyerContract();
	const seller = getBuyerSeller();
	const contentRevision = $derived(content.contentRevision);
	let session = $state.raw<DiscussionSession>();
	$effect(() => {
		void content.templateVersionId;
		const current = untrack(
			() =>
				new DiscussionSession(publicClient, { kind: 'buyer', token }, () => contentRevision, {
					policy: () => seller?.discussionPolicy ?? { readOnly: false, generation: 0 },
					buyerName: () => publicContract.buyerName
				})
		);
		session = current;
		onSession(current);
		return () => {
			current.destroy();
			if (session === current) {
				session = undefined;
				onSession(undefined);
			}
		};
	});
	$effect(() => {
		const current = session;
		const enabled = active && prepare;
		untrack(() => current?.setActive(enabled));
	});
</script>
