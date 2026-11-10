<script lang="ts">
	import ContractCreationSkeleton from './ContractCreationSkeleton.svelte';
	import { useWorkspacePresentation } from '$lib/auth/workspace-presentation.svelte';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { getWorkspaceRuntime } from '$lib/auth/workspace-context.svelte';
	import { loadComponent } from '$lib/auth/component-loader.svelte';
	import { useViewerSession } from '$lib/auth/viewer-session.svelte';
	import DocumentSkeleton from '$lib/components/document/DocumentSkeleton.svelte';
	import HubSpotDealPicker from './HubSpotDealPicker.svelte';
	import CompanyNameDialog from '$lib/components/ui/modal/CompanyNameDialog.svelte';
	import { useHubSpotDeals } from '$lib/hubspot-deals.svelte';
	import ModalShell from '$lib/ui/ModalShell.svelte';
	import Button from '$lib/ui/Button.svelte';
	import type { ContractCreationInput } from '$lib/contract/saved';
	import type { Id } from '../../../convex/_generated/dataModel';
	let {
		onOpen,
		onCreate = () => {},
		showPreview = true
	}: {
		onOpen: (id: Id<'savedContracts'>) => Promise<boolean>;
		onCreate?: () => void;
		showPreview?: boolean;
	} = $props();
	const runtime = getWorkspaceRuntime();
	const presentation = useWorkspacePresentation();
	const session = useViewerSession();
	const connection = useHubSpotDeals().connection;
	const creation = loadComponent(
		() => import('./ContractCreation.svelte'),
		() => true,
		() => session.transportGeneration
	);
	const ContractCreation = $derived(creation.component);
	let controller = $state<{ submit: (input?: ContractCreationInput) => Promise<void> }>();
	let createdId = $state<Id<'savedContracts'> | null>(null);
	let busy = $state(false);
	let locked = $state(false);
	let selectedDeal = $state<{ id: string; name: string } | null>(null);
	let error = $state<string | null>(null);
	let deleted = $state(false);
	let dialogOpen = $state(false);
	let dealsPending = $state(true);
	let selectionEligible = $state(false);
	const presentationOutcome = $derived(
		busy
			? 'pending'
			: runtime.error || creation.failed || error || connection.error
				? 'error'
				: dialogOpen &&
					  runtime.hostReady &&
					  controller &&
					  connection.data &&
					  (connection.data.status !== 'connected' || !connection.data.enabled || !dealsPending)
					? 'success'
					: 'pending'
	);
	beforeNavigate((navigation) => {
		if (session.closing) return;
		if (session.blocked && !navigation.willUnload) {
			navigation.cancel();
			return;
		}
		if (busy && navigation.to?.url.pathname !== `/contracts/${createdId}`) navigation.cancel();
	});
	async function cancel() {
		if (busy) return;
		try {
			await goto('/contracts');
		} catch {
			error = 'We couldn’t return to Contracts. Try again.';
		}
	}
	async function submitDeal() {
		if (deleted) return cancel();
		if (createdId || locked) return controller?.submit();
		if (
			selectedDeal &&
			!connection.isLoading &&
			!connection.error &&
			selectionEligible &&
			connection.data?.status === 'connected' &&
			connection.data.connectionId &&
			connection.data.enabled
		)
			await controller?.submit({
				kind: 'deal',
				dealId: selectedDeal.id,
				connectionId: connection.data.connectionId
			});
	}
</script>

{#snippet creationError()}
	{#if runtime.error || creation.failed || error}
		<p role="alert" class="mt-3 text-sm text-danger">
			{runtime.error ||
				(creation.failed ? 'We couldn’t load contract creation. Reload to try again.' : error)}
		</p>
	{/if}
{/snippet}

{#if ContractCreation}
	<ContractCreation
		bind:this={controller}
		bind:createdId
		bind:busy
		bind:locked
		bind:error
		bind:deleted
		{onOpen}
		{onCreate}
		onDealConflict={(dealId) => {
			if (selectedDeal?.id === dealId) selectedDeal = null;
		}}
		{showPreview}
	/>
{:else if showPreview}
	<main inert aria-hidden="true" class="pointer-events-none pt-6 pb-12 blur-sm">
		<DocumentSkeleton embedded announce={false} />
	</main>
{/if}
<WorkspacePresentationReporter active={!runtime.paused} outcome={presentationOutcome} />
{#if !connection.data && !connection.error}
	<ContractCreationSkeleton
		open={!runtime.paused}
		onOpen={() => (dialogOpen = true)}
		onClose={() => void cancel()}>{@render creationError()}</ContractCreationSkeleton
	>
{:else if (connection.data?.status === 'uninstalled' || connection.data?.status === 'uninstalling') && !connection.error}
	<CompanyNameDialog
		onOpen={() => (dialogOpen = true)}
		title="Name your contract"
		open={!runtime.paused}
		submitLabel={deleted ? 'Back to Contracts' : createdId ? 'Open contract' : 'Create contract'}
		submitDisabled={connection.isLoading ||
			Boolean(connection.error) ||
			!runtime.hostReady ||
			!controller}
		busyLabel={createdId ? 'Opening…' : 'Creating…'}
		lockName={locked || Boolean(createdId) || deleted}
		nameLabel="Contract name"
		{busy}
		error={runtime.error ||
			(creation.failed ? 'We couldn’t create this contract. Try again.' : error)}
		onRetry={runtime.error || creation.failed
			? () => {
					presentation?.restart();
					runtime.error ? runtime.retry() : creation.retry();
				}
			: undefined}
		onSubmit={(name) => void (deleted ? cancel() : controller?.submit({ kind: 'manual', name }))}
		onExistingSubmit={deleted || createdId || locked
			? () => void (deleted ? cancel() : controller?.submit())
			: undefined}
		onClose={() => void cancel()}
	/>
{:else}
	<ModalShell
		open={!runtime.paused}
		title={connection.data ? 'Choose a HubSpot deal' : 'Create a contract'}
		onOpen={() => (dialogOpen = true)}
		onClose={() => void cancel()}
		dismissible={!busy}
		showCloseButton={false}
		closeOnBackdrop={false}
	>
		{#if connection.error}
			<p role="alert" class="text-sm text-danger">
				We couldn’t check your HubSpot installation. <button
					class="underline"
					onclick={() => connection.retry?.()}>Try again</button
				>
			</p>
		{:else}
			<HubSpotDealPicker
				bind:selected={selectedDeal}
				bind:pending={dealsPending}
				bind:selectionEligible
				disabled={busy || locked || Boolean(createdId) || deleted}
			/>
		{/if}
		{@render creationError()}
		{#snippet footer()}<div class="ml-auto flex gap-2">
				<Button variant="secondary" disabled={busy} onclick={() => void cancel()}>Cancel</Button>
				<Button
					disabled={busy ||
						!runtime.hostReady ||
						!controller ||
						(!createdId &&
							!deleted &&
							!locked &&
							(!selectedDeal ||
								!selectionEligible ||
								connection.data?.status !== 'connected' ||
								!connection.data.enabled))}
					onclick={() => void submitDeal()}
				>
					{busy
						? createdId
							? 'Opening…'
							: 'Creating…'
						: deleted
							? 'Back to Contracts'
							: createdId
								? 'Open contract'
								: locked
									? 'Retry creation'
									: 'Create contract'}
				</Button>
			</div>{/snippet}
	</ModalShell>
{/if}
