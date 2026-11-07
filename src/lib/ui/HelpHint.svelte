<script lang="ts">
	import QuestionIcon from 'phosphor-svelte/lib/QuestionIcon';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import { hints, type HintId } from './hints';

	let { id, label }: { id: HintId; label: string } = $props();
</script>

<Tooltip
	text={hints[id].text}
	{label}
	class="rounded-md border-hairline border-edge bg-surface px-2 py-1 text-left text-xs leading-[1.4] text-ink shadow-floating"
>
	{#snippet children()}
		<QuestionIcon weight="regular" class="size-3.5 text-ink-muted/50" aria-hidden="true" />
	{/snippet}
</Tooltip>
