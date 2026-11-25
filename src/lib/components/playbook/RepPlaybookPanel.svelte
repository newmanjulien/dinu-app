<script lang="ts">
	import type { DeepReadonly } from '$lib/immutable';
	import type { RepInstructionRecord } from '$lib/playbook/model';
	import { approvalGuidanceField, instructionsFields } from '$lib/playbook/instructions-fields';
	import InlineAction from './InlineAction.svelte';
	import ConcessionRow from './ConcessionRow.svelte';
	import PlaybookSection from './PlaybookSection.svelte';
	import ClauseText from './ClauseText.svelte';
	import PlaybookText from './PlaybookText.svelte';

	let {
		item,
		selectedOptionId = null,
		disabled = false,
		animateContent = false,
		onConcessionInteraction,
		onToggle
	}: {
		item: DeepReadonly<RepInstructionRecord>;
		selectedOptionId?: string | null;
		disabled?: boolean;
		animateContent?: boolean;
		onConcessionInteraction: (id: string | null) => void;
		onToggle: (id: string | null) => void;
	} = $props();

	let open = $state<string | null>(null);
	const itemId = $derived(item._id);
	const instructions = $derived(item.instructions);
	const approvalGuidance = $derived(
		item.approvalPolicy.kind === 'required' ? item.approvalPolicy.instructions : ''
	);
	const hasSections = $derived(
		Boolean(
			item.concessions.length ||
			instructionsFields.slice(1).some((field) => instructions[field.key]?.trim()) ||
			approvalGuidance.trim()
		)
	);
	$effect(() => {
		void itemId;
		open = null;
	});
</script>

{#key itemId}
	<ClauseText text={instructions.summary ?? ''} {animateContent} />
	{#if hasSections}
		<div
			class={`${animateContent ? 'motion-safe:animate-[clause-panel-content-in_140ms_ease-out_both] [animation-delay:24ms]' : ''} flex flex-col gap-2`}
		>
			{#each instructionsFields.slice(1) as field}
				{#if instructions[field.key]?.trim()}
					<PlaybookSection value={field.key} label={field.label} bind:open>
						<PlaybookText text={instructions[field.key] ?? ''} />
					</PlaybookSection>
				{/if}
			{/each}
			{#if approvalGuidance.trim()}
				<PlaybookSection value="approval-policy" label={approvalGuidanceField.label} bind:open>
					<PlaybookText text={approvalGuidance} />
				</PlaybookSection>
			{/if}
			{#each ['preferred', 'rare'] as tier}
				{@const concessions = item.concessions.filter((concession) => concession.tier === tier)}
				{#if concessions.length}
					<PlaybookSection
						value={tier}
						label={`${tier === 'preferred' ? 'Preferred' : 'Rare'} ${concessions.length === 1 ? 'option' : 'options'}`}
						danger={tier === 'rare'}
						bind:open
					>
						{#each concessions as concession, i (concession.id)}
							{@const selected = selectedOptionId === concession.id}
							{@const label = selected ? 'Remove option' : 'Apply option'}
							{@const descriptionId = `concession-${concession.id}-description`}
							<ConcessionRow description={concession.description} {descriptionId}>
								<InlineAction
									danger={selected}
									{disabled}
									label={concessions.length > 1
										? `${label}, option ${i + 1} of ${concessions.length}`
										: undefined}
									describedBy={descriptionId}
									onclick={() => {
										onConcessionInteraction(selected ? null : concession.id);
										onToggle(selected ? null : concession.id);
									}}>{label}</InlineAction
								>
							</ConcessionRow>
						{/each}
					</PlaybookSection>
				{/if}
			{/each}
		</div>
	{/if}
{/key}
