<script lang="ts">
	import { tick } from 'svelte';
	import DotsThreeVerticalIcon from 'phosphor-svelte/lib/DotsThreeVerticalIcon';
	import SquareIconButton from '$lib/components/ui/SquareIconButton.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import { fieldClass } from '$lib/ui/field-styles';
	import Button from '$lib/ui/Button.svelte';
	import type { DeepReadonly } from '$lib/playbook/draft';
	import type { Concession } from '$lib/playbook/model';
	import { instructionsFields } from '$lib/playbook/instructions-fields';
	import type { AuthoringController } from '$lib/playbook/authoring-controller.svelte';
	import ConcessionCreationEditor from './ConcessionCreationEditor.svelte';
	import ConcessionRow from './ConcessionRow.svelte';
	import InlineAction from './InlineAction.svelte';
	import PlaybookCard from './PlaybookCard.svelte';
	import PlaybookSection from './PlaybookSection.svelte';
	let {
		controller,
		onCancel,
		onPrimary,
		onRetry,
		onDelete
	}: {
		controller: AuthoringController;
		onCancel: () => void;
		onPrimary: () => void;
		onRetry: () => void;
		onDelete: () => void;
	} = $props();
	const draft = $derived(controller.draft!);
	const creating = $derived(controller.creating);
	const canCancel = $derived(controller.canCancel);
	const step = $derived(controller.step);
	const stagedCreation = $derived(controller.stagedCreation);
	const phase = $derived(controller.phase);
	const primaryAction = $derived(controller.primaryAction);
	const actionError = $derived(primaryAction.reason);
	const saving = $derived(phase?.kind === 'saving');
	const forwardDisabled = $derived(primaryAction.disabled);
	const menuId = $props.id();
	let menuOpen = $state(false);
	let menuButton = $state<HTMLButtonElement>();
	const addButtons: Partial<Record<Concession['tier'], HTMLButtonElement>> = {};
	const tiers = ['preferred', 'rare'] as const;
	const textareaClass = `${fieldClass} block min-h-28 resize-y py-2 leading-[1.45]`;

	async function requestConcessionDelete(concession: DeepReadonly<Concession>) {
		if (!window.confirm(`Remove this concession from the draft?\n\n${concession.description}`))
			return;
		const key = controller.entry;
		if (!controller.removeConcession(concession.id)) return;
		await tick();
		if (controller.entry === key) addButtons[concession.tier]?.focus();
	}

	const creationConcession = $derived(controller.creationConcession);
	const stepTitle = $derived(
		step === 'concession' ? 'Add a concession your reps can make' : 'Other part of contract'
	);
	const forwardLabel = $derived(primaryAction.label);
	let open = $state<string | null>(null);
</script>

<PlaybookCard label="Instruction box editor">
	{#if !creating && draft.persistedId}
		<div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
			<span class="min-w-0 text-[14px] font-medium text-ink-secondary"
				>Edit the instructions your reps see</span
			>
			<div class="flex shrink-0 items-center gap-1">
				<div>
					<SquareIconButton
						size="sm"
						type="button"
						aria-label="Instruction box options"
						disabled={!controller.canDelete}
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
								disabled={!controller.canDelete}
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
			class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-[14px] font-medium text-ink-secondary"
		>
			<span class="min-w-0">{stagedCreation ? stepTitle : 'Explain this clause for reps'}</span>
		</div>
	{/if}
	<fieldset disabled={!controller.canEdit} class="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
		{#if !creating || !creationConcession}
			<textarea
				class={textareaClass}
				aria-label="Summary for this clause"
				placeholder={instructionsFields[0].placeholder}
				bind:value={
					() => draft.instructions.summary ?? '',
					(text) => controller.setInstruction('summary', text)
				}></textarea>
		{:else if step === 'concession'}
			<ConcessionCreationEditor
				concession={creationConcession}
				affectsOtherParts={controller.affectsOtherParts}
				onAffectedPart={(value) => controller.setAffectedPart(value)}
				onDescription={(text) => controller.setConcessionDescription(text)}
				onReplacement={(text) => controller.setReplacement(0, text)}
				onTier={(tier) => controller.setConcessionTier(tier)}
			/>
		{:else}
			<div class="flex flex-col gap-3 text-[14px] leading-[1.45] text-ink-muted">
				{#if !creationConcession.changes[1]}
					<p class="m-0 text-sm">
						Scroll to the right spot then select the other clause of the contract which is affected
						by this concession.
					</p>
				{/if}
				<textarea
					aria-label="Replacement clause"
					class={textareaClass}
					placeholder="Write the text that would replace this new clause you highlighted"
					disabled={!creationConcession.changes[1]}
					bind:value={
						() =>
							creationConcession.changes[1]?.replacement
								.map((atom) => (atom.kind === 'text' ? atom.text : ''))
								.join('') ?? '',
						(text) => controller.setReplacement(1, text)
					}></textarea>
			</div>
		{/if}
		{#if !creating}
			<div class="flex min-w-0 flex-col gap-2 text-[14px] leading-[1.45] text-ink-muted">
				{#each instructionsFields.slice(1) as field}
					<PlaybookSection value={field.key} label={field.label} bind:open>
						<textarea
							class={textareaClass}
							aria-label={`${field.label} for this clause`}
							placeholder={field.placeholder}
							bind:value={
								() => draft.instructions[field.key] ?? '',
								(text) => controller.setInstruction(field.key, text)
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
							onclick={() => controller.addConcession(tier)}
							>{tier === 'rare' ? 'Add a rare concession' : 'Add a concession'}</button
						>
					</PlaybookSection>
				{/each}
			</div>
		{/if}
	</fieldset>
	<div class="flex flex-col gap-2" aria-live="polite">
		{#if controller.statusMessage}
			<p class="m-0 text-sm" class:text-danger={!saving} role="status">
				{controller.statusMessage}
			</p>
		{/if}
		{#if actionError && controller.canEdit}
			<p id={`${menuId}-validation`} class="m-0 text-sm text-danger">{actionError}</p>
		{/if}
		{#if controller.feedback}
			<p class="m-0 text-sm text-danger" role="status">{controller.feedback}</p>
		{/if}
		<div class="flex flex-wrap items-center justify-end gap-3" class:pt-px={stagedCreation}>
			{#if creating && controller.canBack}
				<Button
					variant="secondary"
					class="mr-auto"
					disabled={!controller.canEdit}
					onclick={() => controller.back()}>Back</Button
				>
			{/if}
			{#if phase?.kind === 'uncertain'}
				<Button variant="secondary" onclick={onRetry}>Retry</Button>
			{:else if phase?.kind === 'conflict'}
				<Button variant="secondary" onclick={() => controller.useSaved()}>Use saved version</Button>
			{/if}
			<Button variant="secondary" disabled={!canCancel} onclick={onCancel}>Cancel</Button>
			<Button
				variant="secondary"
				disabled={forwardDisabled}
				aria-describedby={actionError && controller.canEdit ? `${menuId}-validation` : undefined}
				onclick={onPrimary}>{forwardLabel}</Button
			>
		</div>
	</div>
</PlaybookCard>
