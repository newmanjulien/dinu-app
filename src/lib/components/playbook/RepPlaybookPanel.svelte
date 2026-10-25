<script lang="ts">
	import type { PlaybookItemRecord } from '$lib/playbook/model';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import SquareIconButton from '$lib/components/ui/SquareIconButton.svelte';
	import { instructionsFields } from '$lib/playbook/instructions-fields';
	import InlineAction from './InlineAction.svelte';
	import ConcessionRow from './ConcessionRow.svelte';
	import PlaybookCard from './PlaybookCard.svelte';
	import PlaybookSection from './PlaybookSection.svelte';
	import PlaybookText from './PlaybookText.svelte';
	let {
		item,
		selected,
		conflicts = {},
		disabled = false,
		isAdmin = false,
		onToggle,
		onClose
	}: {
		item: PlaybookItemRecord;
		selected?: string;
		conflicts?: Record<string, string>;
		disabled?: boolean;
		isAdmin?: boolean;
		onToggle: (id: string) => void;
		onClose: () => void;
	} = $props();
	let open = $state<string | null>(null);
	let appliedConcession = $state<string | null>(null);
	const itemId = $derived(item._id);
	const approvalHint = $derived(
		appliedConcession && selected === appliedConcession
			? isAdmin
				? "You've auto-approved this concession yourself"
				: item.instructions?.changesNeedApproval?.trim()
					? 'This concession will stay pending until you request and get approval'
					: 'You have the authority to make this concession without approval'
			: ''
	);
	const hasSummary = $derived(Boolean(item.instructions?.summary?.trim()));
	const hasSections = $derived(
		Boolean(
			item.concessions.length ||
			instructionsFields.slice(1).some((field) => item.instructions?.[field.key]?.trim())
		)
	);
	$effect(() => {
		void itemId;
		open = null;
		appliedConcession = null;
	});
</script>

<PlaybookCard label="Instruction box">
	<div
		class={`${hasSummary ? 'block' : 'hidden'} @max-[1150px]:grid @max-[1150px]:grid-cols-[minmax(0,1fr)_auto] @max-[1150px]:items-center @max-[1150px]:gap-6`}
	>
		<div class="flex min-w-0 flex-col gap-3 text-ink-muted">
			{#if hasSummary}<PlaybookText text={item.instructions?.summary ?? ''} />{/if}
		</div>
		<div class="hidden @max-[1150px]:block">
			<SquareIconButton type="button" aria-label="Close playbook" onclick={onClose}>
				<XIcon aria-hidden="true" size={22} weight="regular" />
			</SquareIconButton>
		</div>
	</div>
	{#if hasSections}
		<div class="flex flex-col gap-2">
			{#if item.instructions}
				{#each instructionsFields.slice(1) as field}
					{#if item.instructions[field.key]?.trim()}
						<PlaybookSection value={field.key} label={field.label} bind:open>
							<PlaybookText text={item.instructions[field.key] ?? ''} />
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
							<ConcessionRow
								description={concession.description}
								detail={concession.detail}
								after={concession.after}
								{descriptionId}
							>
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
							{#if conflict}<p id={`${descriptionId}-conflict`} class="m-0 text-sm text-danger">
									{conflict}
								</p>{/if}
						{/each}
					</PlaybookSection>
				{/if}
			{/each}
		</div>
	{/if}
</PlaybookCard>

<p
	role="status"
	class="m-0 px-3.5 text-[13px] leading-[1.45] text-ink-muted @min-[1150px]:mt-3 @max-[1150px]:bg-surface @max-[1150px]:pb-[calc(12px+env(safe-area-inset-bottom))]"
	class:hidden={!approvalHint}
>
	{approvalHint}
</p>
