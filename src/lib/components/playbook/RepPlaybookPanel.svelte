<script lang="ts">
	import { authoringInstructions } from '$lib/playbook/model';
	import type { PlaybookItemRecord } from '$lib/playbook/model';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import SquareIconButton from '$lib/components/ui/SquareIconButton.svelte';
	import { instructionsFields } from '$lib/playbook/instructions-fields';
	import InlineAction from './InlineAction.svelte';
	import ConcessionRow from './ConcessionRow.svelte';
	import PlaybookCard from './PlaybookCard.svelte';
	import PlaybookSection from './PlaybookSection.svelte';
	import PlaybookText from './PlaybookText.svelte';
	import Hint from '$lib/ui/Hint.svelte';
	import type { HintId } from '$lib/ui/hints';
	let {
		item,
		selected,
		conflicts = {},
		disabled = false,
		isAdmin = false,
		animateContent = false,
		onToggle,
		onClose
	}: {
		item: PlaybookItemRecord;
		selected?: string;
		conflicts?: Record<string, string>;
		disabled?: boolean;
		isAdmin?: boolean;
		animateContent?: boolean;
		onToggle: (id: string) => void;
		onClose: () => void;
	} = $props();
	let open = $state<string | null>(null);
	let appliedConcession = $state<string | null>(null);
	const itemId = $derived(item._id);
	const displayedInstructions = $derived(authoringInstructions(item));
	const approvalHint = $derived<HintId | null>(
		appliedConcession && selected === appliedConcession
			? isAdmin
				? 'concessionAutoApproved'
				: item.approvalPolicy.kind === 'required'
					? 'concessionApprovalRequired'
					: 'concessionWithinAuthority'
			: null
	);
	const hasSummary = $derived(Boolean(item.instructions?.summary?.trim()));
	const hasSections = $derived(
		Boolean(
			item.concessions.length ||
			instructionsFields.slice(1).some((field) => displayedInstructions[field.key]?.trim())
		)
	);
	$effect(() => {
		void itemId;
		open = null;
		appliedConcession = null;
	});
</script>

<PlaybookCard label="Instruction box">
	{#key itemId}
		<div
			class={`${hasSummary ? 'block' : 'hidden'} ${animateContent ? 'motion-safe:animate-[clause-panel-content-in_140ms_ease-out_both]' : ''} @max-[1150px]:grid @max-[1150px]:grid-cols-[minmax(0,1fr)_auto] @max-[1150px]:items-center @max-[1150px]:gap-6`}
		>
			<div class="flex min-w-0 flex-col gap-3 text-ink-muted">
				{#if hasSummary}<PlaybookText text={item.instructions?.summary ?? ''} />{/if}
			</div>
			<div class="hidden @max-[1150px]:block">
				<SquareIconButton type="button" aria-label="Close playbook" onclick={onClose}>
					<XIcon aria-hidden="true" class="size-5.5" weight="regular" />
				</SquareIconButton>
			</div>
		</div>
		{#if hasSections}
			<div
				class={`${animateContent ? 'motion-safe:animate-[clause-panel-content-in_140ms_ease-out_both] [animation-delay:24ms]' : ''} flex flex-col gap-2`}
			>
				{#if item.instructions || item.approvalPolicy.kind === 'required'}
					{#each instructionsFields.slice(1) as field}
						{#if displayedInstructions[field.key]?.trim()}
							<PlaybookSection value={field.key} label={field.label} bind:open>
								<PlaybookText text={displayedInstructions[field.key] ?? ''} />
							</PlaybookSection>
						{/if}
					{/each}
				{/if}
				{#each ['preferred', 'rare'] as tier}
					{@const concessions = item.concessions.filter((concession) => concession.tier === tier)}
					{#if concessions.length}
						<PlaybookSection
							value={tier}
							label={`${tier === 'preferred' ? 'Preferred' : 'Rare'} ${concessions.length === 1 ? 'concession' : 'concessions'}`}
							danger={tier === 'rare'}
							bind:open
						>
							{#each concessions as concession, i (concession.id)}
								{@const applied = selected === concession.id}
								{@const conflict = !applied && conflicts[concession.id]}
								{@const descriptionId = `concession-${concession.id}-description`}
								<ConcessionRow description={concession.description} {descriptionId}>
									<InlineAction
										danger={applied}
										disabled={disabled || Boolean(conflict)}
										label={concessions.length > 1
											? `${applied ? 'Remove' : 'Apply'} concession ${i + 1} of ${concessions.length}`
											: undefined}
										describedBy={conflict
											? `${descriptionId} ${descriptionId}-conflict`
											: descriptionId}
										onclick={() => {
											appliedConcession = applied ? null : concession.id;
											onToggle(concession.id);
										}}>{applied ? 'Remove concession' : 'Apply concession'}</InlineAction
									>
								</ConcessionRow>
								{#if conflict}<p
										id={`${descriptionId}-conflict`}
										class="m-0 text-[14px] @min-[1150px]:text-[clamp(13px,1cqw,14px)] text-danger"
									>
										{conflict}
									</p>{/if}
							{/each}
						</PlaybookSection>
					{/if}
				{/each}
			</div>
		{/if}
	{/key}
</PlaybookCard>

<Hint
	id={approvalHint}
	role="status"
	class="@min-[1150px]:mt-3 @max-[1150px]:bg-surface @max-[1150px]:pb-[calc(12px+env(safe-area-inset-bottom))]"
/>
