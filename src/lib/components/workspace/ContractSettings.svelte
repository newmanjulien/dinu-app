<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy, untrack } from 'svelte';
	import type { Id } from '../../../convex/_generated/dataModel';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { getContractEditors } from '$lib/contract/editors.svelte';
	import { saveError } from '$lib/contract/saved';
	import { workBlockMessage } from '$lib/contract/work-policy';
	import SettingsCard from '$lib/features/settings/SettingsCard.svelte';
	import { useHubSpotDeals } from '$lib/hubspot-deals.svelte';
	import Button from '$lib/ui/Button.svelte';
	import ConfirmModal from '$lib/ui/ConfirmModal.svelte';
	import TextInput from '$lib/ui/TextInput.svelte';
	import ContractSettingsLayout from './ContractSettingsLayout.svelte';
	import { contractSettingsFields } from '$lib/features/settings/contract-settings-fields';
	import HubSpotRelink from './HubSpotRelink.svelte';

	let { id }: { id: string } = $props();
	const viewer = useViewer();
	const session = useViewerSession();
	const saves = getContractEditors();
	const hubspot = useHubSpotDeals();
	const connection = hubspot.connection;
	const acquired = untrack(() => saves.retainMetadata(id));
	onDestroy(acquired.release);
	const read = acquired.read;
	const contract = $derived(read.data);
	let draftName = $state('');
	let nameDirty = $state(false);
	$effect(() => {
		if (!nameDirty && contract) draftName = contract.title;
	});

	const manualNaming = $derived(
		!connection.error &&
			!connection.isLoading &&
			(connection.data?.status === 'uninstalled' || connection.data?.status === 'uninstalling')
	);
	const currentHubSpotLink = $derived(
		Boolean(
			contract?.hubspot &&
			contract.hubspot.connectionId === connection.data?.connectionId &&
			contract.hubspot.accountId === connection.data?.accountId
		)
	);
	let relinking = $state(false);
	let renaming = $state(false);
	let deleting = $state(false);
	let deleted = $state(false);
	let contractToDelete = $state.raw<{ id: Id<'savedContracts'>; title: string } | null>(null);
	let renameError = $state<string | null>(null);
	let deleteError = $state<string | null>(null);
	const disabled = $derived(
		session.blocked || !read.current || Boolean(read.error) || renaming || deleting || relinking
	);
	let alive = true;
	onDestroy(() => {
		alive = false;
	});

	async function rename(name: string) {
		if (!alive || !contract || disabled || contract.workBlock || !manualNaming) return;
		renaming = true;
		renameError = null;
		try {
			await saves.rename(contract._id, name);
			if (alive && draftName.trim() === name) nameDirty = false;
		} catch (error) {
			if (alive) renameError = saveError(error, 'We couldn’t rename this contract. Try again.');
		} finally {
			if (alive) renaming = false;
		}
	}

	function requestDelete() {
		if (!alive || !contract || disabled) return;
		deleteError = null;
		contractToDelete = { id: contract._id, title: contract.title };
	}

	async function confirmDelete() {
		const request = contractToDelete;
		if (!request || !alive) return;
		if (!contract || contract._id !== request.id || disabled) {
			deleteError = 'This contract is no longer ready to delete. Close and try again.';
			return;
		}
		deleting = true;
		deleteError = null;
		try {
			await saves.remove(request.id);
			if (!alive) return;
			deleted = true;
			contractToDelete = null;
		} catch (error) {
			if (alive) deleteError = saveError(error, 'We couldn’t delete this contract. Try again.');
		} finally {
			if (alive) deleting = false;
		}
		if (alive && deleted) void goto('/contracts').catch(() => {});
	}
</script>

{#if contractToDelete}
	<ConfirmModal
		title="Delete contract?"
		message={`Delete the contract for “${contractToDelete.title}”? This permanently removes its saved choices and document snapshot.`}
		confirmLabel="Delete contract"
		pendingLabel="Deleting…"
		destructive
		busy={deleting}
		error={deleteError}
		onConfirm={confirmDelete}
		onCancel={() => {
			contractToDelete = null;
			deleteError = null;
		}}
	/>
{/if}

{#if relinking && contract && !session.blocked}
	<HubSpotRelink
		contractId={contract._id}
		link={contract.hubspot}
		onClose={() => (relinking = false)}
	/>
{/if}

<WorkspacePresentationReporter
	outcome={read.error ? 'error' : contract !== undefined || deleted ? 'success' : 'pending'}
/>

{#snippet content()}
	{#if deleted}
		<p role="status" class="text-sm text-ink-muted">Contract deleted.</p>
		<div><Button href="/contracts" variant="secondary">Back to Contracts</Button></div>
	{:else if read.error && !contract && !deleting}
		<div role="alert" class="text-sm">
			<p>We couldn’t load the contract settings.</p>
			<Button variant="secondary" class="mt-4" onclick={read.retry}>Try again</Button>
		</div>
	{:else if contract}
		{#if !read.current && read.error}<p class="text-sm text-ink-muted" role="alert">
				We couldn’t refresh these settings.
				<button class="underline" onclick={read.retry}>Try again</button>
			</p>{/if}
		{#if manualNaming || !connection.data || connection.isLoading}
			<SettingsCard
				title={contractSettingsFields.name.title}
				description={contractSettingsFields.name.description}
			>
				<div class="mt-4 max-w-sm">
					<label class="sr-only" for="contract-name">Contract name</label>
					<TextInput
						id="contract-name"
						type="text"
						bind:value={draftName}
						maxlength={200}
						oninput={() => {
							nameDirty = true;
							renameError = null;
						}}
					/>
					{#if renameError}<p role="alert" class="mt-2 text-sm text-danger">{renameError}</p>{/if}
				</div>
				{#snippet footer()}<p>
						{contract.workBlock
							? workBlockMessage(contract.workBlock)
							: contractSettingsFields.name.footerText}
					</p>{/snippet}
				{#snippet action()}<Button
						disabled={disabled ||
							!manualNaming ||
							Boolean(contract.workBlock) ||
							!draftName.trim() ||
							draftName.trim() === contract.title ||
							draftName.trim().length > 200}
						onclick={() => void rename(draftName.trim())}>{renaming ? 'Saving...' : 'Save'}</Button
					>{/snippet}
			</SettingsCard>
		{:else}
			<SettingsCard
				title={contractSettingsFields.name.title}
				description="The contract name is set by the HubSpot deal you link."
			>
				<div class="mt-4 max-w-sm">
					<label class="sr-only" for="contract-name">Contract name</label>
					<TextInput id="contract-name" type="text" readonly value={contract.title} />
				</div>
				{#snippet footer()}
					{#if connection.error}
						<p role="alert">We couldn’t check your HubSpot installation.</p>
					{:else if connection.data && !connection.isLoading && connection.data.status !== 'connected'}
						<p>Ask an admin to reconnect HubSpot before choosing a deal.</p>
					{:else if connection.data && !connection.isLoading && !connection.data.enabled}
						<p>HubSpot is temporarily unavailable.</p>
					{:else if connection.data && !connection.isLoading && contract.workBlock}
						<p>{workBlockMessage(contract.workBlock)}</p>
					{:else if connection.data && !connection.isLoading}
						<p>Link a different deal to change this contract’s name.</p>
					{/if}
				{/snippet}
				{#snippet action()}
					{#if connection.error}
						<Button variant="secondary" {disabled} onclick={() => connection.retry?.()}>
							Try again
						</Button>
					{:else}
						<Button disabled={disabled || !hubspot.identity} onclick={() => (relinking = true)}>
							{currentHubSpotLink ? 'Link another deal' : 'Link a HubSpot deal'}
						</Button>
					{/if}
				{/snippet}
			</SettingsCard>
		{/if}
		<SettingsCard
			title={contractSettingsFields.danger.title}
			description={contractSettingsFields.danger.description}
		>
			{#snippet footer()}<p>{contractSettingsFields.danger.footerText}</p>{/snippet}
			{#snippet action()}
				<Button
					{disabled}
					class="bg-danger text-white not-disabled:not-aria-disabled:hover:bg-danger-hover"
					onclick={requestDelete}
				>
					{deleting ? 'Deleting…' : 'Delete contract'}
				</Button>
			{/snippet}
		</SettingsCard>
	{:else}
		<p class="text-sm text-ink-muted">This contract may have been deleted.</p>
		<div><Button href="/contracts" variant="secondary">Back to Contracts</Button></div>
	{/if}
{/snippet}
<ContractSettingsLayout
	{id}
	title={contract?.title}
	children={contract === undefined && !read.error && !deleted ? undefined : content}
/>
