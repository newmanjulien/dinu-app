<script lang="ts">
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
	import Checkbox from '$lib/components/ui/Checkbox.svelte';
	import Popover from '$lib/components/ui/Popover.svelte';
	import { fieldClass } from '$lib/ui/field-styles';
	import { secondaryButtonClass } from '$lib/ui/button-styles';
	import type { DeepReadonly } from '$lib/playbook/draft';
	import type { Concession } from '$lib/playbook/model';
	let {
		concession,
		affectsOtherParts,
		onAffectedPart,
		onDescription,
		onReplacement,
		onTier
	}: {
		concession: DeepReadonly<Concession>;
		affectsOtherParts: boolean;
		onAffectedPart: (value: boolean) => void;
		onDescription: (text: string) => void;
		onReplacement: (text: string) => void;
		onTier: (tier: Concession['tier']) => void;
	} = $props();
	const optionsId = $props.id();
	let optionsOpen = $state(false);
	let optionsButton = $state<HTMLButtonElement>();
	let keyboardOpen = $state(false);
	const textareaClass = `${fieldClass} block min-h-28 resize-y py-2 leading-[1.45]`;
	const selectedOptions = $derived(
		[concession.tier === 'rare' && 'Rare concession', affectsOtherParts && 'Affects another part']
			.filter(Boolean)
			.join(', ')
	);
</script>

<div class="flex flex-col gap-3 text-[14px] leading-[1.45] text-ink-muted">
	<textarea
		class={textareaClass}
		aria-label="Primary replacement clause"
		required
		placeholder="Write the text that would replace the clause you highlighted"
		bind:value={
			() =>
				concession.changes[0].replacement
					.map((atom) => (atom.kind === 'text' ? atom.text : ''))
					.join(''),
			onReplacement
		}></textarea>
	<textarea
		class={textareaClass}
		aria-label="Concession description"
		required
		placeholder="Explain the concession in plain English so reps understand the change they're making"
		bind:value={() => concession.description, onDescription}></textarea>
	<div>
		<button
			bind:this={optionsButton}
			type="button"
			class={`${secondaryButtonClass} flex w-full cursor-pointer items-center justify-between gap-3 rounded-button-xl px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent`}
			aria-label="Concession options"
			aria-expanded={optionsOpen}
			aria-controls={optionsId}
			onclick={(event) => {
				keyboardOpen = event.detail === 0;
				optionsOpen = !optionsOpen;
			}}
			onkeydown={(event) => {
				if (event.key === 'ArrowDown') {
					event.preventDefault();
					keyboardOpen = true;
					optionsOpen = true;
				}
			}}
		>
			<span class={selectedOptions ? 'text-ink' : ''}>
				{selectedOptions || 'Options'}
			</span>
			<CaretDownIcon
				aria-hidden="true"
				size={16}
				class={`shrink-0 ${optionsOpen ? 'rotate-180' : ''}`}
			/>
		</button>
		<Popover
			open={optionsOpen}
			trigger={optionsButton}
			onClose={() => (optionsOpen = false)}
			keyboard={keyboardOpen}
			id={optionsId}
			label="Concession options"
		>
			<Checkbox
				label="This is a rare concession"
				checked={concession.tier === 'rare'}
				onCheckedChange={(checked) => onTier(checked ? 'rare' : 'preferred')}
				className="rounded-button-sm px-3 py-2 hover:bg-control-fill"
			/>
			<Checkbox
				label="This concession affects another part of the contract"
				checked={affectsOtherParts}
				onCheckedChange={onAffectedPart}
				className="rounded-button-sm px-3 py-2 hover:bg-control-fill"
			/>
		</Popover>
	</div>
</div>
