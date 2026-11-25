<script lang="ts">
	import { untrack } from 'svelte';
	import { useConvexClient } from 'convex-svelte';
	import { DiscussionSession } from '$lib/discussions/session.svelte';
	import type { DiscussionAccess } from '$lib/discussions/validators';
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
	function currentActor() {
		const identity = seller?.identity;
		const accountIdentity = seller?.accountIdentity;
		const sellerClient = seller?.client;
		const membershipId = seller?.viewer?.membershipId;
		const id = seller?.viewer?.contractId;
		const privateAccess =
			seller?.visible && sellerClient && membershipId && id ? { membershipId, id } : undefined;
		const mode = seller?.preview ? 'preview' : privateAccess ? 'seller' : 'buyer';
		return {
			key: JSON.stringify([
				mode,
				mode === 'seller' ? identity : null,
				mode === 'seller' ? accountIdentity : null,
				mode === 'seller' ? membershipId : null,
				mode === 'seller' ? id : null
			]),
			client: privateAccess ? sellerClient! : publicClient,
			privateAccess
		};
	}
	$effect(() => {
		void content.templateVersionId;
		const access: DiscussionAccess = { token };
		const current = untrack(
			() =>
				new DiscussionSession(
					publicClient,
					access,
					() => contentRevision,
					() => seller?.discussionPolicy ?? { readOnly: false, generation: 0 },
					() => publicContract.buyerName,
					undefined,
					() => (seller?.presentation === 'seller' ? 'seller' : 'buyer'),
					() =>
						Boolean(
							seller?.presentation === 'seller' &&
							seller.viewer &&
							!seller.viewer.profile.name.trim()
						)
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
		const actor = currentActor();
		untrack(() =>
			current.transitionActor(actor.key, actor.client, actor.privateAccess, () => {
				const live = currentActor();
				return live.key === actor.key && live.client === actor.client;
			})
		);
	});
	$effect(() => session?.setActive(active && prepare));
	$effect(() => {
		const current = session;
		if (!current) return;
		const identity = seller?.identity;
		const accountIdentity = seller?.accountIdentity;
		const actorVersion = current.transitionVersion;
		const previewVersion = seller?.discussionPolicy.generation;
		const canSend = current.captureWriteAccess();
		const eligible =
			active &&
			prepare &&
			canSend() &&
			current.privateAccess &&
			seller?.visible &&
			identity &&
			accountIdentity &&
			seller?.client;
		untrack(() =>
			current.reads.configure(
				eligible
					? JSON.stringify([identity, accountIdentity, token, actorVersion, previewVersion])
					: undefined,
				eligible
					? (messages) =>
						canSend()
							? seller!.markMessagesSeen(identity!, accountIdentity!, messages)
							: Promise.resolve(false)
					: undefined
			)
		);
	});
</script>
