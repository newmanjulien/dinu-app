<script lang="ts">
	import type { DeepReadonly } from '$lib/immutable';
	import type { TemplateItemRecord } from '$lib/playbook/structure';
	import { isRepItem } from '$lib/playbook/model';
	import { approvalGuidanceField, instructionsFields } from '$lib/playbook/instructions-fields';
	import PlaybookText from './PlaybookText.svelte';
	let { item }: { item: DeepReadonly<TemplateItemRecord> } = $props();
</script>

{#if isRepItem(item)}
	{#each instructionsFields as field}
		{#if item.instructions[field.key]}
			<section class="grid gap-1">
				<h3 class="text-xs font-medium text-ink-muted">{field.label}</h3>
				<PlaybookText text={item.instructions[field.key] ?? ''} />
			</section>
		{/if}
	{/each}
	{#if item.approvalPolicy.kind === 'required'}
		<section class="grid gap-1">
			<h3 class="text-xs font-medium text-ink-muted">{approvalGuidanceField.label}</h3>
			<PlaybookText text={item.approvalPolicy.instructions} />
		</section>
	{/if}
	{#each item.concessions as concession}
		<section class="grid gap-1">
			<h3 class="text-xs font-medium text-ink-muted">
				{concession.tier === 'preferred' ? 'Preferred concession' : 'Rare concession'}
			</h3>
			<PlaybookText text={concession.description} />
		</section>
	{/each}
{:else}
	<PlaybookText text={item.explanation} />
{/if}
