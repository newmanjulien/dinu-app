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
	const concession = $derived(controller.concessionComposer);
	const addingConcession = $derived(Boolean(concession));
	const phase = $derived(controller.phase);
	const primaryAction = $derived(controller.primaryAction);
	const actionReason = $derived(primaryAction.reason);
	const forwardDisabled = $derived(primaryAction.disabled);
	const concessionAdditionReason = $derived(controller.concessionAdditionReason);
	const concessionAdditionDisabled = $derived(Boolean(concessionAdditionReason));
	const menuId = $props.id();
	let fieldset = $state<HTMLFieldSetElement>();
	let actionHintTrigger = $state<HTMLSpanElement>();
	let menuOpen = $state(false);
	let menuButton = $state<HTMLButtonElement | null>();
	const addButtons: Partial<Record<Concession['tier'], HTMLButtonElement>> = {};
	let addButtonTriggers = $state<Partial<Record<Concession['tier'], HTMLSpanElement>>>({});
	const tiers = ['preferred', 'rare'] as const;
	let concessionToDelete = $state.raw<{
		concession: DeepReadonly<Concession>;
		entry: typeof controller.entry;
	} | null>(null);

	function focusCreationField(node: HTMLFieldSetElement) {
		if (draft.persistedId) return;
		const openedEntry = entry;
		let active = true;
		void tick().then(() => {
			if (!active || controller.entry !== openedEntry || !controller.canEdit) return;
			node.querySelector<HTMLElement>('textarea')?.focus({ preventScroll: true });
		});
		return {
			destroy() {
				active = false;
			}
		};
	}

	async function focusReplacementEditor(openedEntry: object | null) {
		await tick();
		if (controller.entry !== openedEntry || !controller.canEdit) return;
		fieldset
			?.querySelector<HTMLElement>('[contenteditable="plaintext-only"]')
			?.focus({ preventScroll: true });
	}

	async function startConcession(tier: Concession['tier']) {
		const openedEntry = entry;
		if (!controller.addConcession(tier)) return;
		await focusReplacementEditor(openedEntry);
	}

	export function focusAddConcession(tier: Concession['tier']) {
		if (!controller.canEdit) return;
		(addButtons[tier]?.disabled ? addButtonTriggers[tier] : addButtons[tier])?.focus({
			preventScroll: true
		});
	}

	function requestConcessionDelete(target: DeepReadonly<Concession>) {
		concessionToDelete = { concession: target, entry: controller.entry };
	}

	async function confirmConcessionDelete() {
		const request = concessionToDelete;
		if (!request) return;
		concessionToDelete = null;
		if (controller.entry !== request.entry) return;
		if (!controller.removeConcession(request.concession.id)) return;
		await tick();
		if (controller.entry === request.entry) focusAddConcession(request.concession.tier);
	}

	const stepTitle = $derived(
		concession?.tier === 'rare' ? 'Add a rare concession' : 'Add a preferred concession'
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
	<div
		class={[
			'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3',
			animateContent && 'motion-safe:animate-[clause-panel-content-in_140ms_ease-out_both]'
		]}
	>
		<span class="min-w-0 text-[14px] font-medium text-ink-secondary">
			{addingConcession ? stepTitle : copy.editingTitle}
		</span>
		{#if !addingConcession && draft.persistedId}
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
		{/if}
	</div>
	<fieldset
		bind:this={fieldset}
		use:focusCreationField
		disabled={!controller.canEdit}
		class={[
			'm-0 flex min-w-0 flex-col gap-2 border-0 p-0',
			animateContent &&
				'motion-safe:animate-[clause-panel-content-in_140ms_ease-out_both] [animation-delay:24ms]'
		]}
	>
		{#if !repDraft}
			<TextArea
				aria-label="Explanation"
				placeholder="Explain this clause in plain English for buyers"
				bind:value={
					() => (!isRepItem(draft) ? draft.explanation : ''),
					(text) => controller.setExplanation(text)
				}
			/>
		{:else if concession}
			<ConcessionCreationEditor
				{concession}
				affectsOtherParts={controller.affectsOtherParts}
				affectedPartAvailable={controller.affectedPartAvailable}
				onAffectedPart={(value) => controller.setAffectedPart(value)}
				onDescription={(text) => controller.setConcessionDescription(text)}
				onReplacement={(index, atoms) => controller.setReplacement(index, atoms)}
				disabled={!controller.canEdit}
				catalog={controller.referenceCatalog}
				paragraphs={(index) => controller.replacementUsesParagraphs(index)}
			/>
		{:else}
			<TextArea
				aria-label="Summary for this clause"
				placeholder={instructionsFields[0].placeholder}
				bind:value={
					() => repDraft.instructions.summary ?? '',
					(text) => controller.setInstruction('summary', text)
				}
			/>
			<div class="flex min-w-0 flex-col gap-2 text-[14px] leading-[1.45] text-ink-muted">
				{#each instructionsFields.slice(1) as field}
					<PlaybookSection value={field.key} label={field.label} bind:open>
						<TextArea
							aria-label={`${field.label} for this clause`}
							placeholder={field.placeholder}
							bind:value={
								() => repDraft.instructions[field.key] ?? '',
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
								repDraft.approvalPolicy.kind === 'required'
									? repDraft.approvalPolicy.instructions
									: '',
							(text) => controller.setApprovalGuidance(text)
						}
					/>
				</PlaybookSection>
				{#each tiers as tier}
					{@const concessions = repDraft.concessions.filter((item) => item.tier === tier)}
					{@const addLabel = tier === 'rare' ? 'Add a rare concession' : 'Add a concession'}
					<PlaybookSection
						value={tier}
						label={`${tier === 'preferred' ? 'Preferred' : 'Rare'} concessions`}
						danger={tier === 'rare'}
						bind:open
					>
						{#each concessions as item (item.id)}
							{@const descriptionId = `${menuId}-concession-${item.id}`}
							<ConcessionRow description={item.description} {descriptionId}>
								<InlineAction
									danger
									describedBy={descriptionId}
									onclick={() => requestConcessionDelete(item)}>Delete concession</InlineAction
								>
							</ConcessionRow>
						{/each}
						<Tooltip
							text={concessionAdditionReason}
							trigger={addButtonTriggers[tier]}
							standalone={false}
							enabled={concessionAdditionDisabled}
						>
							{#snippet children(descriptionId)}
								<!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users focus this wrapper to read why the disabled button is unavailable.) -->
								<span
									bind:this={addButtonTriggers[tier]}
									class="inline-flex self-start rounded-button-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
									role={concessionAdditionDisabled ? 'group' : undefined}
									tabindex={concessionAdditionDisabled ? 0 : undefined}
									aria-label={concessionAdditionDisabled ? addLabel : undefined}
									aria-describedby={concessionAdditionDisabled ? descriptionId : undefined}
								>
									<button
										bind:this={addButtons[tier]}
										type="button"
										disabled={concessionAdditionDisabled}
										aria-describedby={concessionAdditionDisabled ? descriptionId : undefined}
										class="cursor-pointer whitespace-nowrap border-0 bg-transparent p-0 text-accent [font:inherit] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:text-ink-muted/60 disabled:no-underline"
										onclick={() => void startConcession(tier)}>{addLabel}</button
									>
								</span>
							{/snippet}
						</Tooltip>
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
		<div class="flex flex-wrap items-center justify-end gap-3" class:pt-px={addingConcession}>
			{#if phase?.kind === 'conflict'}
				<Button variant="secondary" onclick={() => controller.useSaved()}>Use saved version</Button>
			{/if}
			<Button variant="secondary" onclick={onCancel}>Cancel</Button>
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
						role={actionReason ? 'group' : undefined}
						tabindex={actionReason ? 0 : undefined}
						aria-label={actionReason ? forwardLabel : undefined}
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
