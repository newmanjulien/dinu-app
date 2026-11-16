<script lang="ts">
	import FocusedChangePreview from './FocusedChangePreview.svelte';
	import type { FocusedPreview } from '$lib/contract/document-preview';
	import type { PlaybookState, PlaybookCommand } from '$lib/contract/changes';
	import type { DeepReadonly } from '$lib/immutable';

	import type { ResolvedContractItem } from '$lib/contract/items';
	import { approvalGuidanceField, instructionsFields } from '$lib/playbook/instructions-fields';
	import InlineAction from './InlineAction.svelte';
	import ConcessionRow from './ConcessionRow.svelte';
	import PlaybookCard from './PlaybookCard.svelte';
	import PlaybookSection from './PlaybookSection.svelte';
	import ClauseText from './ClauseText.svelte';
	import PlaybookText from './PlaybookText.svelte';
	import Hint from '$lib/ui/Hint.svelte';
	import type { HintId } from '$lib/ui/hints';
	let {
		item,
		selected,
		entry,
		intent,
		preview,
		previewBusy = false,
		previewError,
		onPrefetch,
		onWithdraw,
		onApprove,
		disabled = false,
		isAdmin = false,
		animateContent = false,
		onToggle,
		onClose
	}: {
		item: DeepReadonly<ResolvedContractItem>;
		selected?: string;
		entry?: PlaybookState;
		intent?: PlaybookCommand['action'];
		preview?: FocusedPreview | null;
		previewBusy?: boolean;
		previewError?: string | null;
		onPrefetch?: () => void;
		onWithdraw: () => void;
		onApprove?: () => void;
		disabled?: boolean;
		isAdmin?: boolean;
		animateContent?: boolean;
		onToggle: (id: string | null) => void;
		onClose: () => void;
	} = $props();
	let open = $state<string | null>(null);
	let appliedConcession = $state<string | null>(null);
	const itemId = $derived(item._id);
	const applied = $derived(entry?.appliedOptionId ?? null);
	const pending = $derived(
		intent?.kind === 'set' || (!intent && entry && entry.currentChangeId !== entry.appliedChangeId)
	);
	const pendingOption = $derived(intent?.kind === 'set' ? intent.optionId : entry?.currentOptionId);
	const immediate = $derived(isAdmin || item.review.kind === 'none');
	const appliedDescription = $derived(
		item.choices.find((choice) => choice.id === applied)?.description
	);
	const pendingDescription = $derived(
		item.choices.find((choice) => choice.id === pendingOption)?.description
	);

	const instructions = $derived(
		item.origin.kind === 'template' ? item.origin.instructions : undefined
	);
	const approvalGuidance = $derived(
		item.origin.kind === 'template' && item.review.kind === 'required'
			? (item.review.instructions ?? '')
			: ''
	);
	const approvalHint = $derived<HintId | null>(
		appliedConcession && selected === appliedConcession
			? isAdmin
				? 'concessionAutoApproved'
				: item.review.kind === 'required'
					? 'concessionApprovalRequired'
					: 'concessionWithinAuthority'
			: null
	);
	const hasSections = $derived(
		Boolean(
			item.choices.length ||
			instructionsFields.slice(1).some((field) => instructions?.[field.key]?.trim()) ||
			approvalGuidance.trim()
		)
	);
	$effect(() => {
		void itemId;
		open = null;
		appliedConcession = null;
	});
</script>

<div role="group" aria-label="Playbook options" onpointerenter={onPrefetch} onfocusin={onPrefetch}>
	<PlaybookCard label="Playbook">
		{#key itemId}
			<ClauseText
				text={instructions?.summary ?? ''}
				closeLabel="Close instructions"
				{onClose}
				{animateContent}
			/>
			{#if appliedDescription}<p class="m-0 text-ink-secondary">
					Applied option: {appliedDescription}
				</p>{/if}
			{#if intent?.kind === 'withdraw'}
				<p class="m-0 text-ink-muted" role="status">Withdrawing pending change…</p>
			{:else if pending}
				<p class="m-0 text-ink-secondary" role="status">
					{entry?.status === 'rejected' && !intent ? 'Declined' : 'Pending'}
					{pendingOption === null
						? 'removal of the applied option'
						: applied
							? 'switch'
							: 'option'}{pendingDescription ? `: ${pendingDescription}` : ''}
				</p>
				{#if pendingOption === null && onApprove}<InlineAction {disabled} onclick={onApprove}
						>Approve change</InlineAction
					>{/if}
				<InlineAction {disabled} danger onclick={onWithdraw}>Withdraw pending change</InlineAction>
			{/if}
			{#if hasSections}
				<div
					class={`${animateContent ? 'motion-safe:animate-[clause-panel-content-in_140ms_ease-out_both] [animation-delay:24ms]' : ''} flex flex-col gap-2`}
				>
					{#if item.origin.kind === 'template' && (instructions || item.review.kind === 'required')}
						{#each instructionsFields.slice(1) as field}
							{#if instructions?.[field.key]?.trim()}
								<PlaybookSection value={field.key} label={field.label} bind:open>
									<PlaybookText text={instructions?.[field.key] ?? ''} />
								</PlaybookSection>
							{/if}
						{/each}
						{#if approvalGuidance.trim()}
							<PlaybookSection
								value="approval-policy"
								label={approvalGuidanceField.label}
								bind:open
							>
								<PlaybookText text={approvalGuidance} />
							</PlaybookSection>
						{/if}
					{/if}
					{#each ['preferred', 'rare'] as tier}
						{@const concessions = item.choices.filter(
							(concession) => (concession.tier ?? 'preferred') === tier
						)}
						{#if concessions.length}
							<PlaybookSection
								value={tier}
								label={`${tier === 'preferred' ? 'Preferred' : 'Rare'} ${concessions.length === 1 ? 'option' : 'options'}`}
								danger={tier === 'rare'}
								bind:open
							>
								{#each concessions as concession, i (concession.id)}
									{@const isApplied = applied === concession.id}
									{@const isPending = pending && pendingOption === concession.id}
									{@const approve = isPending && isAdmin && !intent && Boolean(onApprove)}
									{@const label = approve
										? 'Approve change'
										: isPending
											? 'Withdraw pending change'
											: isApplied && pending
												? 'Keep applied option'
												: isApplied
													? immediate
														? 'Remove option'
														: 'Add removal to approval request'
													: immediate
														? 'Apply option'
														: 'Add to approval request'}
									{@const descriptionId = `concession-${concession.id}-description`}
									<ConcessionRow description={concession.description} {descriptionId}>
										<InlineAction
											danger={isApplied || (isPending && !approve)}
											{disabled}
											label={concessions.length > 1
												? `${label}, option ${i + 1} of ${concessions.length}`
												: undefined}
											describedBy={descriptionId}
											onclick={() => {
												if (approve) {
													onApprove?.();
													return;
												}
												if (isPending) {
													onWithdraw();
													return;
												}
												appliedConcession = isApplied ? null : concession.id;
												onToggle(isApplied && !pending ? null : concession.id);
											}}>{label}</InlineAction
										>
									</ConcessionRow>
								{/each}
							</PlaybookSection>
						{/if}
					{/each}
				</div>
			{/if}
			{#if previewBusy}<p class="m-0 text-ink-muted" role="status">
					Preparing change preview…
				</p>{/if}
			{#if previewError}<p class="m-0 text-danger" role="alert">{previewError}</p>{/if}
			{#if preview}<FocusedChangePreview {preview} />{/if}
		{/key}
	</PlaybookCard>
</div>

<Hint
	id={approvalHint}
	role="status"
	class="@min-[1150px]:mt-3 @max-[1150px]:bg-surface @max-[1150px]:pb-[calc(12px+env(safe-area-inset-bottom))]"
/>
