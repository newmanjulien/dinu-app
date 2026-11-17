<script lang="ts">
	import { untrack } from 'svelte';
	import { useConvexClient } from 'convex-svelte';
	import type { FunctionReturnType } from 'convex/server';
	import type { api } from '../../convex/_generated/api';
	import { DiscussionSession } from '$lib/discussions/session.svelte';
	import { getDiscussionRecovery } from '$lib/discussions/recovery.svelte';
	import type { DiscussionAccess } from '$lib/discussions/validators';
	import { getBuyerSeller } from './seller.svelte';
	import { getBuyerContract } from './contract.svelte';

	type Content = FunctionReturnType<typeof api.buyerLinks.currentDocument>;
	let {
		content,
		token,
		active,
		prepare,
		onSession
	}: {
		content: Content;
		token: string;
		active: boolean;
		prepare: boolean;
		onSession: (session: DiscussionSession | undefined) => void;
	} = $props();
	const publicClient = useConvexClient();
	const publicContract = getBuyerContract();
	const seller = getBuyerSeller();
	const recovery = getDiscussionRecovery();
	const contentRevision = $derived(content.contentRevision);
	const discussionIdentity = $derived(seller?.identity);
	const discussionAccount = $derived(seller?.accountIdentity);
	const discussionMembership = $derived(seller?.viewer?.membershipId);
	const discussionContract = $derived(seller?.viewer?.contractId);
	const discussionPrivate = $derived(Boolean(seller?.visible));
	let session = $state.raw<DiscussionSession>();
	$effect(() => {
		// A different document may no longer contain these passages.
		void content.contentIdentity;
		const identity = discussionIdentity,
			accountIdentity = discussionAccount,
			privateClient = seller?.client,
			membershipId = discussionMembership,
			id = discussionContract,
			sellerAccessEnabled = discussionPrivate;
		const privateAccess =
			sellerAccessEnabled && privateClient && membershipId && id ? { membershipId, id } : undefined;
		const access: DiscussionAccess = { token };
		const current = untrack(
			() =>
				new DiscussionSession(
					privateAccess ? privateClient! : publicClient,
					access,
					() => contentRevision,
					() => content.contentIdentity,
					() => ({
						readOnly:
							identity !== seller?.identity ||
							accountIdentity !== seller?.accountIdentity ||
							Boolean(seller?.discussionPolicy.readOnly),
						generation: seller?.discussionPolicy.generation ?? 0
					}),
					() => publicContract.buyerName,
					privateAccess,
					recovery,
					() => (seller?.presentation === 'seller' ? 'seller' : 'buyer')
				)
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
		if (!current) return;
		const { generation } = current.policy();
		untrack(() => current.synchronizePolicy(generation));
	});
	$effect(() => session?.setActive(active && prepare));
	$effect(() => session?.reconcileOperations());
	$effect(() => session?.persistOperations());
	$effect(() => {
		const current = session;
		if (!current?.active || !current.feed.authorized || !current.feed.firstPageAccepted) return;
		void [...current.work.created];
		untrack(() => current.reconcileCreateOutcomes());
	});
	$effect(() => {
		const current = session;
		if (!current) return;
		const identity = seller?.identity;
		const accountIdentity = seller?.accountIdentity;
		const eligible =
			active &&
			prepare &&
			current.feed.authorized &&
			current.feed.firstPageAccepted &&
			seller?.visible &&
			identity &&
			accountIdentity &&
			seller?.client;
		untrack(() =>
			current.reads.configure(
				eligible ? JSON.stringify([identity, accountIdentity, token]) : undefined,
				eligible
					? (messages) => seller!.markMessagesSeen(identity!, accountIdentity!, messages)
					: undefined
			)
		);
	});
	$effect(() => {
		const current = session;
		if (!current) return;
		const identity = seller?.identity;
		const accountIdentity = seller?.accountIdentity;
		untrack(() => current.recognizeSeller(identity, accountIdentity));
	});
</script>
