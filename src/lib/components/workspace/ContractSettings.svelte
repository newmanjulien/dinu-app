<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy } from 'svelte';
	import { api } from '../../../convex/_generated/api';
	import type { Id } from '../../../convex/_generated/dataModel';
	import { useReadQuery } from '$lib/auth/read-query.svelte';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { getContractEditors } from '$lib/contract/editors.svelte';
	import { saveError } from '$lib/contract/saved';
	import { workBlockMessage } from '$lib/contract/work-policy';
	import SettingsCard from '$lib/features/settings/SettingsCard.svelte';
	import SettingsTextFieldCard from '$lib/features/settings/SettingsTextFieldCard.svelte';
	import { useHubSpotDeals } from '$lib/hubspot-deals.svelte';
	import Button from '$lib/ui/Button.svelte';
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
	const read = useReadQuery(
		api.contracts.state,
		() =>
			session.workspaceAdmitted && !session.blocked && !viewer().company.deletionPending
				? { membershipId: viewer().membership.id, id: id as Id<'savedContracts'> }
				: 'skip',
		() => session.transportGeneration
	);
	const contract = $derived(read.data);
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
	let renameError = $state<string | null>(null);
	let deleteError = $state<string | null>(null);
	const disabled = $derived(
		session.blocked || read.isStale || Boolean(read.error) || renaming || deleting || relinking
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
		} catch (error) {
			if (alive) renameError = saveError(error, 'We couldn’t rename this contract. Try again.');
		} finally {
			if (alive) renaming = false;
		}
	}

	async function remove() {
		if (!alive || !contract || disabled) return;
		if (
			!window.confirm(
				`Delete the contract for “${contract.title}”? This permanently removes its saved choices and document snapshot.`
			)
		)
			return;
		deleting = true;
		deleteError = null;
		try {
			await saves.remove(contract._id);
			if (!alive) return;
			deleted = true;
		} catch (error) {
			if (alive) deleteError = saveError(error, 'We couldn’t delete this contract. Try again.');
		} finally {
			if (alive) deleting = false;
		}
		if (alive && deleted) void goto('/contracts').catch(() => {});
	}
</script>

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
	{:else if deleting && !contract}
		<p role="status" class="text-sm text-ink-muted">Deleting contract…</p>
	{:else if read.error}
		<div role="alert" class="text-sm">
			<p>We couldn’t load the contract settings.</p>
			<Button variant="secondary" class="mt-4" onclick={read.retry}>Try again</Button>
		</div>
	{:else if contract}
		{#if manualNaming}
			<fieldset disabled={disabled || Boolean(contract.workBlock)} class="contents">
				<SettingsTextFieldCard
					kind="contract-name"
					title={contractSettingsFields.name.title}
					description={contractSettingsFields.name.description}
					fieldId="contract-name"
					label="Contract name"
					value={contract.title}
					footerText={contract.workBlock
						? workBlockMessage(contract.workBlock)
						: contractSettingsFields.name.footerText}
					saving={renaming}
					errorText={renameError}
					onSave={rename}
				/>
			</fieldset>
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
					{:else if !connection.data || connection.isLoading}
						<p role="status">Checking HubSpot installation…</p>
					{:else if connection.data.status !== 'connected'}
						<p>Ask an admin to reconnect HubSpot before choosing a deal.</p>
					{:else if !connection.data.enabled}
						<p>HubSpot is temporarily unavailable.</p>
					{:else if contract.workBlock}
						<p>{workBlockMessage(contract.workBlock)}</p>
					{:else}
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
			{#if deleteError}<p role="alert" class="mt-4 text-[0.74rem] text-danger">
					{deleteError}
				</p>{/if}
			{#snippet footer()}<p>{contractSettingsFields.danger.footerText}</p>{/snippet}
			{#snippet action()}
				<Button
					{disabled}
					class="bg-danger text-white not-disabled:not-aria-disabled:hover:bg-danger-hover"
					onclick={() => void remove()}
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
