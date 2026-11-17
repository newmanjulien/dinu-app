<script lang="ts">
	import TextArea from '$lib/ui/TextArea.svelte';
	import { tick } from 'svelte';
	import DotsThreeVerticalIcon from 'phosphor-svelte/lib/DotsThreeVerticalIcon';
	import SquareIconButton from '$lib/components/ui/SquareIconButton.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import Button from '$lib/ui/Button.svelte';
	import ConfirmModal from '$lib/ui/ConfirmModal.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import type { DeepReadonly } from '../../immutable';
	import { isRepItem, type Concession } from '$lib/playbook/model';
	import { approvalGuidanceField, instructionsFields } from '$lib/playbook/instructions-fields';
	import type { AuthoringController } from '$lib/playbook/authoring-controller.svelte';
	import ConcessionCreationEditor from './ConcessionCreationEditor.svelte';
	import ReplacementEditor from './ReplacementEditor.svelte';
	import ConcessionRow from './ConcessionRow.svelte';
	import InlineAction from './InlineAction.svelte';
	import PlaybookSection from './PlaybookSection.svelte';
	let {
		controller,
		animateContent = false,
		onCancel,
		onPrimary,
		onDelete
	}: {
		controller: AuthoringController;
		animateContent?: boolean;
		onCancel: () => void;
		onPrimary: () => void;
		onDelete: () => void;
	} = $props();
	const entry = $derived(controller.entry);
	const draft = $derived(controller.draft!);
	const repDraft = $derived(isRepItem(draft) ? draft : null);
	const copy = $derived(controller.copy);
	const creating = $derived(controller.creating);
	const canCancel = $derived(controller.canCancel);
	const step = $derived(controller.step);
	const stagedCreation = $derived(controller.stagedCreation);
	const phase = $derived(controller.phase);
	const primaryAction = $derived(controller.primaryAction);
	const actionReason = $derived(primaryAction.reason);
	const forwardDisabled = $derived(primaryAction.disabled);
	const menuId = $props.id();
	let actionHintTrigger = $state<HTMLSpanElement>();
	let menuOpen = $state(false);
	let menuButton = $state<HTMLButtonElement | null>();
	const addButtons: Partial<Record<Concession['tier'], HTMLButtonElement>> = {};
	const tiers = ['preferred', 'rare'] as const;
	let concessionToDelete = $state.raw<{
		concession: DeepReadonly<Concession>;
		entry: typeof controller.entry;
	} | null>(null);

	function focusCreationField(fieldset: HTMLFieldSetElement) {
		if (!creating) return;
		const openedEntry = entry;
		let active = true;
		void tick().then(() => {
			if (!active || controller.entry !== openedEntry || !controller.canEdit) return;
			fieldset
				.querySelector<HTMLElement>('textarea, [contenteditable="plaintext-only"]')
				?.focus({ preventScroll: true });
		});
		return {
			destroy() {
				active = false;
			}
		};
	}

	function requestConcessionDelete(concession: DeepReadonly<Concession>) {
		concessionToDelete = { concession, entry: controller.entry };
	}

	async function confirmConcessionDelete() {
		const request = concessionToDelete;
		if (!request) return;
		concessionToDelete = null;
		if (controller.entry !== request.entry) return;
		if (!controller.removeConcession(request.concession.id)) return;
		await tick();
		if (controller.entry === request.entry) addButtons[request.concession.tier]?.focus();
	}

	const creationConcession = $derived(controller.creationConcession);
	const stepTitle = $derived(
		step === 'concession' ? 'Add a concession your reps can make' : 'Other part of contract'
	);
	const forwardLabel = $derived(primaryAction.label);
	let open = $state<string | null>(null);
	$effect(() => {
		void entry;
		menuOpen = false;
		open = null;
		concessionToDelete = null;
	});
</script>

{#key entry}
	{#if !creating && draft.persistedId}
		<div
			class={[
				'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3',
				animateContent && 'motion-safe:animate-[clause-panel-content-in_140ms_ease-out_both]'
			]}
		>
			<span class="min-w-0 text-[14px] font-medium text-ink-secondary">{copy.editingTitle}</span>
			<div class="flex shrink-0 items-center gap-1">
				<div>
					<SquareIconButton
						class="size-[27px]"
						type="button"
						aria-label={copy.optionsLabel}
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
						<DotsThreeVerticalIcon aria-hidden="true" class="size-[19px]" weight="bold" />
					</SquareIconButton>
					<Menu
						open={menuOpen}
						trigger={menuButton ?? undefined}
						onClose={() => (menuOpen = false)}
						id={menuId}
						label={copy.optionsLabel}
					>
						{#snippet children(activate)}
							<MenuItem
								danger
								disabled={!controller.canDelete}
								onclick={() => {
									activate();
									onDelete();
								}}>{copy.deleteAction}</MenuItem
							>
						{/snippet}
					</Menu>
				</div>
			</div>
		</div>
	{:else}
		<div
			class={[
				'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-[14px] font-medium text-ink-secondary',
				animateContent && 'motion-safe:animate-[clause-panel-content-in_140ms_ease-out_both]'
			]}
		>
			<span class="min-w-0">{stagedCreation ? stepTitle : copy.creationTitle}</span>
		</div>
	{/if}
	<fieldset
		use:focusCreationField
		disabled={!controller.canEdit}
		class={[
			'm-0 flex min-w-0 flex-col gap-2 border-0 p-0',
			animateContent &&
				'motion-safe:animate-[clause-panel-content-in_140ms_ease-out_both] [animation-delay:24ms]'
		]}
	>
		{#if !isRepItem(draft)}
			<TextArea
				aria-label="Explanation"
				placeholder="Explain this clause in plain English for buyers"
				bind:value={
					() => (!isRepItem(draft) ? draft.explanation : ''),
					(text) => controller.setExplanation(text)
				}
			/>
		{:else if !creating || !creationConcession}
			<TextArea
				aria-label="Summary for this clause"
				placeholder={instructionsFields[0].placeholder}
				bind:value={
					() => repDraft?.instructions?.summary ?? '',
					(text) => controller.setInstruction('summary', text)
				}
			/>
		{:else if step === 'concession'}
			<ConcessionCreationEditor
				concession={creationConcession}
				affectsOtherParts={controller.affectsOtherParts}
				onAffectedPart={(value) => controller.setAffectedPart(value)}
				onDescription={(text) => controller.setConcessionDescription(text)}
				onReplacement={(text) => controller.setReplacement(0, text)}
				onTier={(tier) => controller.setConcessionTier(tier)}
				disabled={!controller.canEdit}
				catalog={controller.referenceCatalog}
				paragraphs={controller.replacementUsesParagraphs(0)}
			/>
		{:else}
			<div class="flex flex-col gap-3 text-[14px] leading-[1.45] text-ink-muted">
				{#if !creationConcession.changes[1]}
					<p class="m-0 text-sm">
						Select the other affected passage. You can select several adjacent paragraphs, or use an
						insertion point between paragraphs to add a clause.
					</p>
				{/if}
				<ReplacementEditor
					label="Replacement clause"
					placeholder="Write the text that would replace this new clause you highlighted"
					value={creationConcession.changes[1]?.replacement ?? []}
					disabled={!controller.canEdit || !creationConcession.changes[1]}
					catalog={controller.referenceCatalog}
					paragraphs={controller.replacementUsesParagraphs(1)}
					onChange={(atoms) => controller.setReplacement(1, atoms)}
				/>
			</div>
		{/if}
		{#if !creating && repDraft}
			<div class="flex min-w-0 flex-col gap-2 text-[14px] leading-[1.45] text-ink-muted">
				{#each instructionsFields.slice(1) as field}
					<PlaybookSection value={field.key} label={field.label} bind:open>
						<TextArea
							aria-label={`${field.label} for this clause`}
							placeholder={field.placeholder}
							bind:value={
								() => repDraft?.instructions?.[field.key] ?? '',
								(text) => controller.setInstruction(field.key, text)
							}
						/>
					</PlaybookSection>
				{/each}
				<PlaybookSection value="approval-policy" label={approvalGuidanceField.label} bind:open>
					<TextArea
						aria-label={`${approvalGuidanceField.label} for this clause`}
						placeholder={approvalGuidanceField.placeholder}
						bind:value={
							() =>
								repDraft?.approvalPolicy.kind === 'required'
									? repDraft.approvalPolicy.instructions
									: '',
							(text) => controller.setApprovalGuidance(text)
						}
					/>
				</PlaybookSection>
				{#each tiers as tier}
					{@const concessions = repDraft.concessions.filter(
						(concession) => concession.tier === tier
					)}
					<PlaybookSection
						value={tier}
						label={`${tier === 'preferred' ? 'Preferred' : 'Rare'} concessions`}
						danger={tier === 'rare'}
						bind:open
					>
						{#each concessions as concession (concession.id)}
							{@const descriptionId = `${menuId}-concession-${concession.id}`}
							<ConcessionRow description={concession.description} {descriptionId}>
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
	<div
		class={[
			'flex flex-col gap-2',
			animateContent &&
				'motion-safe:animate-[clause-panel-content-in_140ms_ease-out_both] [animation-delay:48ms]'
		]}
	>
		<div class="flex flex-wrap items-center justify-end gap-3" class:pt-px={stagedCreation}>
			{#if creating && controller.canCancelLocation}
				<Button
					variant="secondary"
					class="mr-auto"
					disabled={!controller.canEdit}
					onclick={() => controller.cancelSecondaryLocationChoice()}>Cancel location</Button
				>
			{/if}
			{#if phase?.kind === 'conflict'}
				<Button variant="secondary" onclick={() => controller.useSaved()}>Use saved version</Button>
			{/if}
			<Button variant="secondary" disabled={!canCancel} onclick={onCancel}>Cancel</Button>
			<Tooltip
				text={actionReason}
				trigger={actionHintTrigger}
				standalone={false}
				enabled={Boolean(actionReason)}
			>
				{#snippet children(descriptionId)}
					<!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users focus this wrapper to read why the disabled button is unavailable.) -->
					<span
						bind:this={actionHintTrigger}
						class="inline-flex rounded-button-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
						role="group"
						tabindex={actionReason ? 0 : undefined}
						aria-label={forwardLabel}
						aria-describedby={actionReason ? descriptionId : undefined}
					>
						<Button
							variant="secondary"
							class="disabled:pointer-events-none"
							disabled={forwardDisabled}
							aria-describedby={actionReason ? descriptionId : undefined}
							onclick={onPrimary}>{forwardLabel}</Button
						>
					</span>
				{/snippet}
			</Tooltip>
		</div>
	</div>
{/key}

{#if concessionToDelete}
	<ConfirmModal
		title="Delete concession?"
		message={`Remove this concession from the draft?\n\n${concessionToDelete.concession.description}`}
		confirmLabel="Delete concession"
		destructive
		onConfirm={confirmConcessionDelete}
		onCancel={() => (concessionToDelete = null)}
	/>
{/if}
