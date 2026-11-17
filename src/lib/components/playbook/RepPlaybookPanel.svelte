<script lang="ts">
	import FocusedChangePreview from './FocusedChangePreview.svelte';
	import type { FocusedPreview } from '$lib/contract/document-preview';
	import type { PlaybookState, PlaybookCommand } from '$lib/contract/changes';
	import type { DeepReadonly } from '$lib/immutable';

	import type { ResolvedContractItem } from '$lib/contract/items';
	import { approvalGuidanceField, instructionsFields } from '$lib/playbook/instructions-fields';
	import InlineAction from './InlineAction.svelte';
	import ConcessionRow from './ConcessionRow.svelte';
	import PlaybookSection from './PlaybookSection.svelte';
	import ClauseText from './ClauseText.svelte';
	import PlaybookText from './PlaybookText.svelte';
	let {
		item,
		entry,
		intent,
		preview,
		previewError,
		previewRetryable = false,
		onRetryPreview,
		onWithdraw,
		onApprove,
		disabled = false,
		isAdmin = false,
		animateContent = false,
		onConcessionInteraction,
		onToggle
	}: {
		item: DeepReadonly<ResolvedContractItem>;
		entry?: PlaybookState;
		intent?: PlaybookCommand['action'];
		preview?: FocusedPreview | null;
		previewError?: string | null;
		previewRetryable?: boolean;
		onRetryPreview?: () => void;
		onWithdraw: () => void;
		onApprove?: () => void;
		disabled?: boolean;
		isAdmin?: boolean;
		animateContent?: boolean;
		onConcessionInteraction: (id: string | null) => void;
		onToggle: (id: string | null) => void;
	} = $props();
	let open = $state<string | null>(null);
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
	});
</script>

{#key itemId}
	<ClauseText text={instructions?.summary ?? ''} {animateContent} />
	{#if appliedDescription}<p class="m-0 text-ink-secondary">
			Applied option: {appliedDescription}
		</p>{/if}
	{#if pending && intent?.kind !== 'withdraw'}
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
					<PlaybookSection value="approval-policy" label={approvalGuidanceField.label} bind:open>
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
										onConcessionInteraction(isApplied ? null : concession.id);
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
	{#if previewError}<p class="m-0 text-danger" role="alert">
			{previewError}
			{#if previewRetryable && onRetryPreview}<button
					class="ml-2 underline"
					onclick={onRetryPreview}>Retry</button
				>{/if}
		</p>{/if}
	{#if preview}<FocusedChangePreview {preview} />{/if}
{/key}
