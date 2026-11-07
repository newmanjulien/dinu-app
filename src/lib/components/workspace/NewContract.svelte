<script lang="ts">
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
			await goto('/');
		} catch {
			error = 'We couldn’t return to Home. Try again.';
		}
	}
	async function submitDeal() {
		if (deleted) return cancel();
		if (createdId || locked) return controller?.submit();
		if (
			selectedDeal &&
			selectionEligible &&
			connection.data?.status === 'connected' &&
			connection.data.enabled
		)
			await controller?.submit({ kind: 'deal', dealId: selectedDeal.id });
	}
</script>

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
{#if connection.data?.status === 'uninstalled' && !connection.error}
	<CompanyNameDialog
		onOpen={() => (dialogOpen = true)}
		title="Name your contract"
		open={!runtime.paused}
		submitLabel={deleted ? 'Back to Home' : createdId ? 'Open contract' : 'Create contract'}
		submitDisabled={!runtime.hostReady || !controller}
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
		onClose={() => void cancel()}
	/>
{:else}
	<ModalShell
		open={!runtime.paused}
		title="Choose a HubSpot deal"
		onOpen={() => (dialogOpen = true)}
		onClose={() => void cancel()}
		dismissible={!busy}
		showCloseButton={false}
		closeOnBackdrop={false}
	>
		{#if connection.error}
			<p role="alert" class="text-sm text-danger">
				We couldn’t check your HubSpot installation. Reconnect or reload to continue.
			</p>
		{:else if !connection.data}
			<p role="status" class="text-sm text-ink-muted">Checking HubSpot installation…</p>
		{:else}
			<HubSpotDealPicker
				bind:selected={selectedDeal}
				bind:pending={dealsPending}
				bind:selectionEligible
				disabled={busy || locked || Boolean(createdId) || deleted}
			/>
		{/if}
		{#if runtime.error || creation.failed || error}<p role="alert" class="mt-3 text-sm text-danger">
				{runtime.error ||
					(creation.failed ? 'We couldn’t load contract creation. Reload to try again.' : error)}
			</p>{/if}
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
							? 'Back to Home'
							: createdId
								? 'Open contract'
								: locked
									? 'Retry creation'
									: 'Create contract'}
				</Button>
			</div>{/snippet}
	</ModalShell>
{/if}
