<script lang="ts">
	import { untrack } from 'svelte';
	import { useConvexClient } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import type { Id } from '../../../convex/_generated/dataModel';
	import type { Infer } from 'convex/values';
	import type { hubspotLink } from '../../../convex/hubspotValidators';
	import { useViewer } from '$lib/auth/viewer-session.svelte';
	import ModalShell from '$lib/ui/ModalShell.svelte';
	import Button from '$lib/ui/Button.svelte';
	import HubSpotDealPicker from './HubSpotDealPicker.svelte';
	import { isHubSpotDealConflict, saveError } from '$lib/contract/saved';
	let {
		contractId,
		link,
		onClose
	}: { contractId: Id<'savedContracts'>; link?: Infer<typeof hubspotLink>; onClose: () => void } =
		$props();
	const client = useConvexClient(),
		viewer = useViewer();
	const expectedGeneration = untrack(() => link?.generation ?? null);
	let selected = $state<{ id: string; name: string } | null>(null),
		busy = $state(false),
		error = $state<string | null>(null);
	let request = $state.raw<{ operationId: string; dealId: string } | null>(null);
	let selectionEligible = $state(false);
	let deleted = $state(false);
	const canSubmit = $derived(
		!busy && !deleted && Boolean(request || (selected && selectionEligible))
	);
	async function submit() {
		if (!canSubmit) return;
		if (!request) {
			if (!selected || !selectionEligible) return;
			request = { operationId: crypto.randomUUID(), dealId: selected.id };
		}
		busy = true;
		error = null;
		try {
			const result = await client.action(api.hubspotDeals.link, {
				membershipId: viewer().membership.id,
				contractId,
				expectedGeneration,
				...request
			});
			if (result.status === 'deleted') {
				deleted = true;
				error = 'This contract was deleted. Close this dialog to continue.';
				return;
			}
			onClose();
		} catch (cause) {
			if (request && isHubSpotDealConflict(cause)) {
				if (selected?.id === request.dealId) selected = null;
				request = null;
			}
			error = saveError(cause, 'We couldn’t update this HubSpot link. Try again.');
		} finally {
			busy = false;
		}
	}
</script>

<ModalShell
	open
	title={link ? 'Link another deal' : 'Link a HubSpot deal'}
	{onClose}
	dismissible={!busy}
>
	<p class="mb-4 text-sm text-ink-muted">
		Your contract will be renamed to match the selected deal’s name. Future activity will sync to
		that deal.
	</p>
	<HubSpotDealPicker
		bind:selected
		bind:selectionEligible
		{contractId}
		disabled={busy || Boolean(request) || deleted}
	/>
	{#if error}<p role="alert" class="mt-3 text-sm text-danger">{error}</p>{/if}
	{#snippet footer()}<div class="ml-auto flex gap-2">
			<Button variant="secondary" disabled={busy} onclick={onClose}
				>{deleted ? 'Close' : 'Cancel'}</Button
			><Button disabled={!canSubmit} onclick={() => void submit()}
				>{busy ? 'Linking…' : 'Link deal'}</Button
			>
		</div>{/snippet}
</ModalShell>
