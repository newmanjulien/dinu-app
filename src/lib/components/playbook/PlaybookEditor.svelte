<script lang="ts">
	import { tick } from 'svelte';
	import DotsThreeVerticalIcon from 'phosphor-svelte/lib/DotsThreeVerticalIcon';
	import SquareIconButton from '$lib/components/ui/SquareIconButton.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import type { Concession } from '$lib/playbook/model';
	import { instructionsFields } from '$lib/playbook/instructions-fields';
	import type { AuthoringFlow } from '$lib/playbook/authoring-flow.svelte';
	import ConcessionCreationEditor from './ConcessionCreationEditor.svelte';
	import ConcessionRow from './ConcessionRow.svelte';
	import InlineAction from './InlineAction.svelte';
	import PlaybookCard from './PlaybookCard.svelte';
	import PlaybookSection from './PlaybookSection.svelte';
	let {
		flow,
		onCancel,
		onPrimary,
		onRetry,
		onDelete
	}: {
		flow: AuthoringFlow;
		onCancel: () => void;
		onPrimary: () => void;
		onRetry: () => void;
		onDelete: () => void;
	} = $props();
	const draft = $derived(flow.draft!);
	const creating = $derived(flow.creating);
	const canCancel = $derived(flow.canCancel);
	const step = $derived(flow.step);
	const stagedCreation = $derived(flow.stagedCreation);
	const session = $derived(flow.session);
	const phase = $derived(flow.entry?.phase);
	const actionError = $derived(creating ? flow.readinessReason : session.validation.reason);
	const saving = $derived(phase?.kind === 'saving');
	const forwardDisabled = $derived(
		!session.canEdit ||
			flow.creationIncomplete ||
			Boolean(actionError) ||
			(!(creating && (!flow.lastStep || flow.addingConcession)) && !session.canSave)
	);
	const menuId = $props.id();
	let menuOpen = $state(false);
	let menuButton = $state<HTMLButtonElement>();
	const addButtons: Partial<Record<Concession['tier'], HTMLButtonElement>> = {};
	const tiers = ['preferred', 'rare'] as const;

	async function requestConcessionDelete(concession: Concession) {
		if (!window.confirm(`Remove this concession from the draft?\n\n${concession.description}`))
			return;
		const key = flow.entry?.key;
		if (!flow.removeConcession(concession.id)) return;
		await tick();
		if (flow.entry?.key === key) addButtons[concession.tier]?.focus();
	}

	const creationConcession = $derived(flow.creationConcession);
	const actionButtonClass =
		'cursor-pointer rounded-button-lg border border-line bg-surface px-3 py-2 text-ink/80 text-[14px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';
	const stepTitle = $derived(
		step === 'concession' ? 'Add a concession your reps can make' : 'Other part of contract'
	);
	const forwardLabel = $derived(
		phase?.kind === 'saving'
			? phase.operation.kind === 'delete'
				? 'Deleting…'
				: 'Saving…'
			: stagedCreation && !flow.lastStep
				? 'Add the other part'
				: flow.addingConcession
					? 'Add'
					: 'Save'
	);
	let open = $state<string | null>(null);
</script>

<PlaybookCard label="Instruction box editor">
	{#if !creating && draft.persistedId}
		<div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
			<span class="min-w-0 text-[14px] font-medium text-ink/80"
				>Edit the instructions your reps see</span
			>
			<div class="flex shrink-0 items-center gap-1">
				<div>
					<SquareIconButton
						size="sm"
						type="button"
						aria-label="Instruction box options"
						disabled={!session.canDelete}
						aria-haspopup="menu"
						aria-expanded={menuOpen}
						aria-controls={menuId}
						onclick={() => (menuOpen = !menuOpen)}
						onkeydown={(event) => {
							if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
								event.preventDefault();
								menuOpen = true;
							}
						}}
						bind:element={menuButton}
					>
						<DotsThreeVerticalIcon aria-hidden="true" size={19} weight="bold" />
					</SquareIconButton>
					<Menu
						open={menuOpen}
						trigger={menuButton}
						onClose={() => (menuOpen = false)}
						id={menuId}
						label="Instruction box options"
					>
						{#snippet children(activate)}
							<MenuItem
								danger
								disabled={!session.canDelete}
								onclick={() => {
									activate();
									onDelete();
								}}>Delete instruction box</MenuItem
							>
						{/snippet}
					</Menu>
				</div>
			</div>
		</div>
	{:else}
		<div
			class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-[14px] font-medium text-ink/80"
		>
			<span class="min-w-0">{stagedCreation ? stepTitle : 'Explain this clause for reps'}</span>
		</div>
	{/if}
	<fieldset
		disabled={!session.canEdit}
		class="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
		oninput={() => {
			if (!creating) flow.clearFeedback();
		}}
	>
		{#if creating}
			{#if !creationConcession}
				<textarea
					class="block min-w-0 w-full rounded-base border border-line bg-surface px-3 py-2 text-ink focus:border-accent focus:outline-2 focus:outline-accent/18 focus:outline-offset-1 min-h-28 resize-y placeholder:text-ink-muted"
					aria-label="Summary for this clause"
					placeholder={instructionsFields[0].placeholder}
					bind:value={
						() => draft.instructions.summary ?? '', (text) => (draft.instructions.summary = text)
					}></textarea>
			{:else if step === 'concession'}
				<ConcessionCreationEditor
					concession={creationConcession}
					affectsOtherParts={flow.affectsOtherParts}
					onAffectedPart={(value) => flow.setAffectedPart(value)}
				/>
			{:else}
				<div class="flex flex-col gap-3 text-[14px] leading-[1.45] text-ink-muted">
					{#if !creationConcession.changes[1]}
						<p class="m-0 text-sm">
							Scroll to the right spot then select the other clause of the contract which is
							affected by this concession.
						</p>
					{/if}
					{#if flow.feedback && !flow.additionTargetReason}<p
							class="m-0 text-sm text-danger"
							role="status"
						>
							{flow.feedback}
						</p>{/if}
					<textarea
						aria-label="Replacement clause"
						class="block min-h-28 w-full resize-y rounded-base border border-line bg-surface px-3 py-2 text-ink placeholder:text-ink-muted focus:border-accent focus:outline-2 focus:outline-accent/18 focus:outline-offset-1 disabled:opacity-50"
						placeholder="Write the text that would replace this new clause you highlighted"
						disabled={!creationConcession.changes[1]}
						bind:value={
							() =>
								creationConcession.changes[1]?.replacement
									.map((atom) => (atom.kind === 'text' ? atom.text : ''))
									.join('') ?? '',
							(text) => {
								if (creationConcession.changes[1])
									creationConcession.changes[1].replacement = [{ kind: 'text', text }];
							}
						}></textarea>
				</div>
			{/if}
		{:else}
			<textarea
				class="block min-h-28 min-w-0 w-full resize-y rounded-base border border-line bg-surface px-3 py-2 text-ink placeholder:text-ink-muted focus:border-accent focus:outline-2 focus:outline-accent/18 focus:outline-offset-1"
				aria-label="Summary for this clause"
				placeholder={instructionsFields[0].placeholder}
				bind:value={
					() => draft.instructions.summary ?? '', (text) => (draft.instructions.summary = text)
				}></textarea>
			<div class="flex min-w-0 flex-col gap-2 text-[14px] leading-[1.45] text-ink-muted">
				{#each instructionsFields.slice(1) as field}
					<PlaybookSection value={field.key} label={field.label} bind:open>
						<textarea
							class="block w-full rounded-base border border-line bg-surface px-3 py-2 text-ink focus:border-accent focus:outline-2 focus:outline-accent/18 focus:outline-offset-1 min-h-28 resize-y placeholder:text-ink-muted"
							aria-label={`${field.label} for this clause`}
							placeholder={field.placeholder}
							bind:value={
								() => draft.instructions[field.key] ?? '',
								(text) => (draft.instructions[field.key] = text)
							}></textarea>
					</PlaybookSection>
				{/each}
				{#each tiers as tier}
					{@const concessions = draft.concessions.filter((concession) => concession.tier === tier)}
					<PlaybookSection
						value={tier}
						label={`${tier === 'preferred' ? 'Preferred' : 'Rare'} concessions`}
						danger={tier === 'rare'}
						bind:open
					>
						{#each concessions as concession (concession.id)}
							{@const descriptionId = `${menuId}-concession-${concession.id}`}
							<ConcessionRow
								description={concession.description}
								detail={concession.detail}
								after={concession.after}
								{descriptionId}
							>
								<InlineAction
									danger
									describedBy={descriptionId}
									onclick={() => requestConcessionDelete(concession)}
									>Delete concession</InlineAction
								>
							</ConcessionRow>
						{/each}
						<button
							bind:this={addButtons[tier]}
							type="button"
							class="self-start cursor-pointer whitespace-nowrap border-0 bg-transparent p-0 text-accent [font:inherit] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
							onclick={() => flow.addConcession(tier)}
							>{tier === 'rare' ? 'Add a rare concession' : 'Add a concession'}</button
						>
					</PlaybookSection>
				{/each}
			</div>
		{/if}
	</fieldset>
	<div class="flex flex-col gap-2" aria-live="polite">
		{#if session.statusMessage}
			<p class="m-0 text-sm" class:text-danger={!saving} role="status">{session.statusMessage}</p>
		{/if}
		{#if actionError && session.canEdit}
			<p id={`${menuId}-validation`} class="m-0 text-sm text-danger">{actionError}</p>
		{/if}
		{#if flow.editError}
			<p class="m-0 text-sm text-danger" role="status">{flow.editError}</p>
		{/if}
		<div class="flex flex-wrap items-center justify-end gap-3" class:pt-px={stagedCreation}>
			{#if creating && flow.canBack}
				<button
					type="button"
					class={`${actionButtonClass} mr-auto`}
					disabled={!session.canEdit}
					onclick={() => flow.back()}>Back</button
				>
			{/if}
			{#if phase?.kind === 'uncertain'}
				<button type="button" class={actionButtonClass} onclick={onRetry}>Retry</button>
			{:else if phase?.kind === 'conflict'}
				<button type="button" class={actionButtonClass} onclick={() => flow.useSaved()}
					>Use saved version</button
				>
			{/if}
			<button
				type="button"
				class={`${actionButtonClass} disabled:cursor-default disabled:opacity-45`}
				disabled={!canCancel}
				onclick={onCancel}>Cancel</button
			>
			<button
				type="button"
				class={`${actionButtonClass} disabled:cursor-default disabled:opacity-45`}
				disabled={forwardDisabled}
				aria-describedby={actionError && session.canEdit ? `${menuId}-validation` : undefined}
				onclick={onPrimary}>{forwardLabel}</button
			>
		</div>
	</div>
</PlaybookCard>
