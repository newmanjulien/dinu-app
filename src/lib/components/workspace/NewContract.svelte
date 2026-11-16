<script lang="ts">
	import { useWorkspacePresentation } from '$lib/auth/workspace-presentation.svelte';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import {
		getWorkspaceRuntime,
		getWorkspaceDestinations
	} from '$lib/auth/workspace-context.svelte';
	import { loadComponent } from '$lib/auth/component-loader.svelte';
	import { useViewerSession } from '$lib/auth/viewer-session.svelte';
	import HubSpotDealPicker from './HubSpotDealPicker.svelte';
	import TextInput from '$lib/ui/TextInput.svelte';
	import { onDestroy, onMount, untrack, tick } from 'svelte';
	import { loadContractCreation, warmDocumentDestination } from '$lib/auth/destination-code';
	import { loadDocumentSearch } from '$lib/components/document/document-tools';
	import { afterPaint } from '$lib/document/runtime/scheduler';
	import { useHubSpotDeals } from '$lib/hubspot-deals.svelte';
	import { getTemplateSource } from '$lib/playbook/template-source.svelte';
	import ModalShell from '$lib/ui/ModalShell.svelte';
	import Button from '$lib/ui/Button.svelte';
	import type { ContractCreationInput } from '$lib/contract/saved';
	import type { Id } from '../../../convex/_generated/dataModel';
	let {
		onOpen,
		onCreate = () => {},
		onPrepareSaved,
		previewFailed = false,
		onRetryPreview = () => {}
	}: {
		onOpen: (id: Id<'savedContracts'>) => Promise<boolean>;
		onCreate?: () => void;
		onPrepareSaved: (id: Id<'savedContracts'>) => void;
		previewFailed?: boolean;
		onRetryPreview?: () => void;
	} = $props();
	const runtime = getWorkspaceRuntime();
	const presentation = useWorkspacePresentation();
	const session = useViewerSession();
	const hubspot = useHubSpotDeals();
	const templateSource = getTemplateSource();
	const connection = hubspot.connection;
	const destinations = getWorkspaceDestinations();
	const releaseOpening = untrack(
		() => destinations?.retain('/contracts/new') ?? hubspot.retainOpening()
	);
	onDestroy(() => releaseOpening?.());
	const creation = loadComponent(
		loadContractCreation,
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
	onMount(() => {
		const lifetime = new AbortController();
		void afterPaint(lifetime.signal)
			.then(() => {
				warmDocumentDestination('saved');
				void loadDocumentSearch().catch(() => {});
			})
			.catch(() => {});
		return () => lifetime.abort();
	});
	let dealsPending = $state(true);
	let selectionEligible = $state(false);
	type Mode = 'manual' | 'deal';
	const modeFor = (value: typeof connection.data): Mode | undefined =>
		!value
			? undefined
			: value.status === 'uninstalled' || value.status === 'uninstalling'
				? 'manual'
				: 'deal';
	const currentMode = $derived(
		!connection.isLoading && !connection.error ? modeFor(connection.data) : undefined
	);
	let formMode = $state<Mode | undefined>(untrack(() => modeFor(hubspot.displayConnection)));
	let modeNotice = $state('');
	let name = $state('');
	let validation = $state<string | null>(null);
	let nameInput = $state<HTMLInputElement>();
	let dealPanel = $state<HTMLDivElement>();
	const focused: Partial<Record<Mode, HTMLElement>> = {};
	const formId = $props.id();
	$effect(() => {
		const next = modeFor(hubspot.displayConnection);
		if (!next || locked || createdId || deleted) return;
		untrack(() => {
			if (formMode && next !== formMode)
				modeNotice =
					next === 'deal'
						? 'HubSpot is now installed. Choose a deal to create your contract. Your contract name is kept.'
						: 'HubSpot was disconnected. Name your contract to continue. Your deal search is kept.';
			formMode = next;
		});
	});
	$effect(() => {
		if (!formMode || !dialogOpen) return;
		// The mounted picker acquires its exact IDs in this flush before temporary
		// opening ownership releases; searches then own only their actual candidates.
		void tick().then(() => releaseOpening?.());
	});
	$effect(() => {
		if (!dialogOpen || !formMode) return;
		const mode = formMode;
		void tick().then(() => {
			const previous = focused[mode];
			const target =
				previous?.isConnected && !previous.matches(':disabled')
					? previous
					: mode === 'manual'
						? nameInput
						: dealPanel?.querySelector<HTMLInputElement>('input');
			target?.focus({ preventScroll: true });
		});
	});
	const existingAttempt = $derived(deleted || Boolean(createdId) || locked);
	const canSubmit = $derived(
		!busy &&
			Boolean(controller) &&
			(existingAttempt ||
				Boolean(
					currentMode &&
					currentMode === formMode &&
					(formMode === 'manual' ||
						(selectedDeal &&
							selectionEligible &&
							connection.data?.status === 'connected' &&
							connection.data.enabled))
				))
	);
	const presentationOutcome = $derived(
		busy
			? 'pending'
			: creation.failed || error || connection.error
				? 'error'
				: dialogOpen && controller && currentMode && (currentMode === 'manual' || !dealsPending)
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
	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!canSubmit || session.blocked || session.closing) return;
		if (deleted) return cancel();
		if (createdId || locked) return controller?.submit();
		if (formMode === 'manual' && currentMode === 'manual') {
			if (!name.trim()) {
				validation = 'Enter a contract name.';
				nameInput?.focus();
				return;
			}
			validation = null;
			return controller?.submit({ kind: 'manual', name: name.trim() });
		}
		if (
			formMode === 'deal' &&
			currentMode === 'deal' &&
			selectedDeal &&
			selectionEligible &&
			connection.data?.status === 'connected' &&
			connection.data.enabled &&
			connection.data.connectionId
		)
			await controller?.submit({
				kind: 'deal',
				dealId: selectedDeal.id,
				connectionId: connection.data.connectionId
			});
	}
</script>

{#snippet creationError()}
	{#if creation.failed || error}
		<p role="alert" class="mt-3 text-sm text-danger">
			{creation.failed ? 'We couldn’t load contract creation. Try again.' : error}
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
		{onPrepareSaved}
		onDealConflict={(dealId) => {
			if (selectedDeal?.id === dealId) selectedDeal = null;
		}}
	/>
{/if}
<WorkspacePresentationReporter active={!runtime.paused} outcome={presentationOutcome} />
<ModalShell
	open={!runtime.paused}
	title={formMode === 'manual'
		? 'Name your contract'
		: formMode === 'deal'
			? 'Choose a HubSpot deal'
			: 'Create a contract'}
	onOpen={() => (dialogOpen = true)}
	onClose={() => void cancel()}
	dismissible={!busy}
	showCloseButton={false}
	closeOnBackdrop={false}
>
	<form id={formId} onsubmit={(event) => void submit(event)}>
		{#if modeNotice}<p class="mb-3 text-sm text-ink-muted" role="status">{modeNotice}</p>{/if}
		<div
			hidden={formMode !== 'manual'}
			inert={formMode !== 'manual'}
			onfocusin={(event) => {
				if (event.target instanceof HTMLElement) focused.manual = event.target;
			}}
		>
			<label class="mb-2 block text-sm" for={`${formId}-name`}>Contract name</label>
			<TextInput
				bind:element={nameInput}
				id={`${formId}-name`}
				bind:value={name}
				oninput={() => (validation = null)}
				disabled={busy || existingAttempt}
				maxlength={200}
				autocomplete="organization"
				aria-invalid={Boolean(validation)}
			/>
			{#if validation}<p role="alert" class="mt-3 text-sm text-danger">{validation}</p>{/if}
		</div>
		<div
			bind:this={dealPanel}
			hidden={formMode !== 'deal'}
			inert={formMode !== 'deal'}
			onfocusin={(event) => {
				if (event.target instanceof HTMLElement) focused.deal = event.target;
			}}
		>
			<HubSpotDealPicker
				bind:selected={selectedDeal}
				bind:pending={dealsPending}
				bind:selectionEligible
				active={formMode === 'deal'}
				disabled={busy || existingAttempt}
			/>
		</div>
		{#if !currentMode && !connection.error}
			<p class="mt-3 text-xs text-ink-muted" role="status">Checking HubSpot connection…</p>
		{/if}
		{#if connection.error}<p role="alert" class="mt-3 text-sm text-danger">
				We couldn’t check your HubSpot installation. <button
					type="button"
					class="underline"
					onclick={() => connection.retry?.()}>Try again</button
				>
			</p>{/if}
		{@render creationError()}
		{#if previewFailed}
			<p role="alert" class="mt-3 text-sm text-danger">
				We couldn’t load the contract wording.
				<button
					type="button"
					class="underline"
					onclick={() => {
						if (templateSource.read.error) templateSource.read.retry();
						onRetryPreview();
					}}>Try again</button
				>
			</p>
		{/if}
		{#if creation.failed}<button
				type="button"
				class="mt-2 text-sm underline"
				onclick={() => {
					presentation?.restart();
					creation.retry();
				}}>Try again</button
			>{/if}
	</form>
	{#snippet footer()}<div class="ml-auto flex gap-2">
			<Button variant="secondary" disabled={busy} onclick={() => void cancel()}>Cancel</Button>
			<Button type="submit" form={formId} disabled={!canSubmit}>
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
