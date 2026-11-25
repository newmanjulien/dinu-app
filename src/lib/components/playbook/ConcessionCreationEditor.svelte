<script lang="ts">
	import TextArea from '$lib/ui/TextArea.svelte';
	import Checkbox from '$lib/components/ui/Checkbox.svelte';
	import type { DeepReadonly } from '../../immutable';
	import type { Concession } from '$lib/playbook/model';
	import type { ReplacementAtom } from '$lib/document/source-model';
	import type { ReferenceCatalog } from '$lib/document/reference-catalog';
	import ReplacementEditor from './ReplacementEditor.svelte';
	let {
		concession,
		affectsOtherParts,
		affectedPartAvailable,
		onAffectedPart,
		onDescription,
		onReplacement,
		disabled,
		catalog,
		paragraphs
	}: {
		concession: DeepReadonly<Concession>;
		affectsOtherParts: boolean;
		affectedPartAvailable: boolean;
		onAffectedPart: (value: boolean) => void;
		onDescription: (text: string) => void;
		onReplacement: (index: 0 | 1, atoms: ReplacementAtom[]) => void;
		disabled: boolean;
		catalog: ReferenceCatalog;
		paragraphs: (index: 0 | 1) => boolean;
	} = $props();
	const secondary = $derived(concession.changes[1]);
</script>

<div class="flex flex-col gap-3 text-[14px] leading-[1.45] text-ink-muted">
	<ReplacementEditor
		value={concession.changes[0].replacement}
		label="Primary replacement clause"
		placeholder="Write the text that would replace the clause you highlighted"
		{disabled}
		{catalog}
		paragraphs={paragraphs(0)}
		onChange={(atoms) => onReplacement(0, atoms)}
	/>
	<TextArea
		aria-label="Concession description"
		required
		placeholder="Explain the concession in plain English so reps understand the change they're making"
		bind:value={() => concession.description, onDescription}
	/>
	<Checkbox
		label="This concession affects another part of the template"
		checked={affectsOtherParts}
		onCheckedChange={onAffectedPart}
		disabled={disabled || !affectedPartAvailable}
	/>
	{#if affectsOtherParts}
		{#if secondary}
			<ReplacementEditor
				label="Replacement clause for the other part"
				placeholder="Write the text that would replace the other passage you highlighted"
				value={secondary.replacement}
				{disabled}
				{catalog}
				paragraphs={paragraphs(1)}
				onChange={(atoms) => onReplacement(1, atoms)}
			/>
		{:else}
			<p class="m-0 text-sm" role="status">
				Select the other affected passage. You can select several adjacent paragraphs, or use an
				insertion point between paragraphs to add a clause.
			</p>
		{/if}
	{/if}
</div>
