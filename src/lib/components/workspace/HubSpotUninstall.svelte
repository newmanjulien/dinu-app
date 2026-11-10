<script lang="ts">
	import TextInput from '$lib/ui/TextInput.svelte';
	import { onDestroy, tick } from 'svelte';
	import { useConvexClient } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import type { Id } from '../../../convex/_generated/dataModel';
	import { useHubSpotDeals } from '$lib/hubspot-deals.svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { saveError } from '$lib/contract/saved';
	import { getIntegrationFeedback } from '$lib/integration-feedback.svelte';
	import Button from '$lib/ui/Button.svelte';
	import ModalShell from '$lib/ui/ModalShell.svelte';

	let {
		quotes = false,
		onUninstalled
	}: {
		quotes?: boolean;
		onUninstalled: () => void;
	} = $props();
	const client = useConvexClient();
	const viewer = useViewer();
	const session = useViewerSession();
	const connection = useHubSpotDeals().connection;
	const feedback = getIntegrationFeedback();
	const installed = $derived(
		quotes
			? Boolean(connection.data?.quotes?.installed)
			: connection.data?.status === 'connected' || connection.data?.status === 'reconnect'
	);
	const formId = $props.id();
	const name = $derived(quotes ? 'HubSpot Quotes' : 'HubSpot');
	const confirmationPhrase = $derived(`uninstall ${name}`);
	let confirmationText = $state('');
	const canUninstall = $derived(confirmationText.trim() === confirmationPhrase);
	let target = $state<
		| { kind: 'base'; id: Id<'hubspotConnections'>; shared: boolean; quotes: boolean }
		| {
				kind: 'quotes';
				id: Id<'hubspotQuoteInstallations'>;
				epoch: number;
				connectionId: Id<'hubspotConnections'>;
		  }
		| null
	>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let mounted = true;
	onDestroy(() => (mounted = false));

	async function uninstall() {
		if (!target || busy || !canUninstall) return;
		const installation = target;
		const membershipId = viewer().membership.id;
		busy = true;
		error = null;
		try {
			if (installation.kind === 'quotes') {
				await client.mutation(api.hubspotQuotesInstallation.uninstall, {
					membershipId,
					installationId: installation.id,
					epoch: installation.epoch
				});
				if (!session.workspaceAdmitted || viewer().membership.id !== membershipId) return;
				feedback.trackQuotesRemoval(installation.id, installation.epoch, installation.connectionId);
			} else {
				const removalId = await client.mutation(api.hubspotUninstall.uninstall, {
					membershipId,
					connectionId: installation.id
				});
				if (!session.workspaceAdmitted || viewer().membership.id !== membershipId) return;
				feedback.trackRemoval(removalId, installation.id);
			}
			target = null;
			await tick();
			if (mounted && session.workspaceAdmitted && viewer().membership.id === membershipId)
				onUninstalled();
		} catch (cause) {
			error = saveError(cause, `We couldn’t uninstall ${name}. Try again.`);
		} finally {
			busy = false;
		}
	}
</script>

{#if installed && connection.data?.connectionId}
	<Button
		variant="secondary"
		class="shadow-none"
		aria-haspopup="dialog"
		onclick={() => {
			const current = connection.data;
			if (quotes && current?.quotes?.installationId && current.connectionId)
				target = {
					kind: 'quotes',
					id: current.quotes.installationId,
					epoch: current.quotes.epoch,
					connectionId: current.connectionId
				};
			else if (current?.connectionId)
				target = {
					kind: 'base',
					id: current.connectionId,
					shared: current.shared,
					quotes: current.quotes?.installed ?? false
				};
			confirmationText = '';
			error = null;
		}}>Uninstall {name}</Button
	>
{/if}
{#if target}
	<ModalShell
		title={`Uninstall ${name}?`}
		dismissible={!busy}
		onClose={() => {
			target = null;
		}}
	>
		<form
			id={formId}
			class="space-y-4"
			onsubmit={(event) => {
				event.preventDefault();
				void uninstall();
			}}
		>
			<p class="text-sm leading-6 text-ink-secondary">
				{#if target.kind === 'quotes'}
					This removes HubSpot Quotes for everyone in this workspace and restores DOCX downloads.
					HubSpot stays connected. Your contracts, approvals and deal links stay in Dinu. Existing
					quotes stay in HubSpot. A push already being sent may still finish.
				{:else}
					This disconnects HubSpot for everyone in this workspace. Your contracts and approvals stay
					in Dinu. Anything already sent to HubSpot stays there.
				{/if}
			</p>
			{#if target.kind === 'base' && target.quotes}
				<p class="text-sm leading-6 text-ink-secondary">
					This also disables HubSpot Quotes in this workspace. Existing HubSpot quotes stay.
				</p>
			{/if}
			{#if target.kind === 'base' && target.shared}
				<p class="text-sm leading-6 text-ink-secondary">
					Other workspaces connected to this HubSpot account will stay connected.
				</p>
			{/if}
			<div>
				<label for={`${formId}-confirmation`} class="block text-xs text-ink">
					Type <strong>"{confirmationPhrase}"</strong> to continue
				</label>
				<TextInput
					id={`${formId}-confirmation`}
					type="text"
					bind:value={confirmationText}
					autocomplete="off"
					spellcheck={false}
					disabled={busy}
					oninput={() => (error = null)}
					class="mt-2"
				/>
			</div>
			{#if error}<p role="alert" class="text-sm text-danger">{error}</p>{/if}
		</form>
		{#snippet footer()}
			<div class="ml-auto flex gap-2">
				<Button variant="secondary" disabled={busy} onclick={() => (target = null)}>Cancel</Button>
				<Button
					type="submit"
					form={formId}
					disabled={busy || !canUninstall}
					class="bg-danger text-white not-disabled:not-aria-disabled:hover:bg-danger-hover"
					>{busy ? 'Uninstalling…' : `Uninstall ${name}`}</Button
				>
			</div>
		{/snippet}
	</ModalShell>
{/if}
