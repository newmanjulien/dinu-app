<script lang="ts">
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
	import Checkbox from '$lib/components/ui/Checkbox.svelte';
	import Popover from '$lib/components/ui/Popover.svelte';
	import type { DeepReadonly } from '../../immutable';
	import type { Concession } from '$lib/playbook/model';
	import type { ReplacementAtom } from '$lib/contract/source-model';
	import type { ReferenceCatalog } from '$lib/contract/reference-catalog';
	import ReplacementEditor from './ReplacementEditor.svelte';
	let {
		concession,
		affectsOtherParts,
		onAffectedPart,
		onDescription,
		onReplacement,
		onTier,
		disabled,
		catalog,
		paragraphs
	}: {
		concession: DeepReadonly<Concession>;
		affectsOtherParts: boolean;
		onAffectedPart: (value: boolean) => void;
		onDescription: (text: string) => void;
		onReplacement: (atoms: ReplacementAtom[]) => void;
		onTier: (tier: Concession['tier']) => void;
		disabled: boolean;
		catalog: ReferenceCatalog;
		paragraphs: boolean;
	} = $props();
	const optionsId = $props.id();
	let optionsOpen = $state(false);
	let optionsButton = $state<HTMLButtonElement>();
	let keyboardOpen = $state(false);
	const selectedOptions = $derived(
		[concession.tier === 'rare' && 'Rare concession', affectsOtherParts && 'Affects another part']
			.filter(Boolean)
			.join(', ')
	);
</script>

<div class="flex flex-col gap-3 text-[14px] leading-[1.45] text-ink-muted">
	<ReplacementEditor
		value={concession.changes[0].replacement}
		label="Primary replacement clause"
		placeholder="Write the text that would replace the clause you highlighted"
		{disabled}
		{catalog}
		{paragraphs}
		onChange={onReplacement}
	/>
	<textarea
		class="w-full rounded-button-lg border-hairline border-edge bg-surface px-3 shadow-control outline-none transition-[background-color] focus-within:border-accent focus-within:outline-solid focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent/18 not-disabled:not-aria-disabled:[&:not([readonly])]:not-aria-invalid:hover:not-focus-within:bg-field-hover not-disabled:not-aria-disabled:aria-invalid:border-danger/30 not-disabled:not-aria-disabled:aria-invalid:bg-danger-surface not-disabled:not-aria-disabled:aria-invalid:text-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:border-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:outline-danger/18 motion-reduce:transition-none min-w-0 text-[13px] placeholder:font-[350] placeholder:text-ink-muted text-ink disabled:bg-canvas disabled:text-ink-muted [&[readonly]]:bg-canvas [&[readonly]]:text-ink-muted block min-h-28 resize-y py-2 leading-[1.45]"
		aria-label="Concession description"
		required
		placeholder="Explain the concession in plain English so reps understand the change they're making"
		bind:value={() => concession.description, onDescription}></textarea>
	<div>
		<button
			bind:this={optionsButton}
			type="button"
			class="border-hairline border-edge bg-surface shadow-control transition-colors not-disabled:not-aria-disabled:hover:bg-surface-hover motion-reduce:transition-none flex w-full cursor-pointer items-center justify-between gap-3 rounded-button-xl px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
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
				class={`size-4 shrink-0 ${optionsOpen ? 'rotate-180' : ''}`}
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
				class="rounded-button-sm px-3 py-2 hover:bg-surface-hover"
			/>
			<Checkbox
				label="This concession affects another part of the contract"
				checked={affectsOtherParts}
				onCheckedChange={onAffectedPart}
				class="rounded-button-sm px-3 py-2 hover:bg-surface-hover"
			/>
		</Popover>
	</div>
</div>
