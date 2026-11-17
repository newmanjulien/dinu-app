<script lang="ts">
	import type { Snippet } from 'svelte';
	import StatusBubble from './StatusBubble.svelte';
	import type { OperationStatus as StatusItem } from './operation-status';
	import type { RenderFailure } from '$lib/document/runtime/types';

	let {
		feedback = null,
		renderError = null,
		sourceStale = false,
		onRetryRender,
		notice = null,
		saveAttention = false,
		saveCompletion = false,
		saveFeedback
	}: {
		feedback?: StatusItem | null;
		renderError?: RenderFailure | null;
		sourceStale?: boolean;
		onRetryRender?: () => void;
		notice?: StatusItem | null;
		saveAttention?: boolean;
		saveCompletion?: boolean;
		saveFeedback?: Snippet;
	} = $props();
</script>

{#snippet status(item: StatusItem)}
	<StatusBubble urgent={item.urgent}>
		{item.message}
		{#each item.actions ?? [] as action}
			<button
				type="button"
				class="pointer-events-auto ml-2 cursor-pointer font-medium text-accent underline"
				onclick={action.run}>{action.label}</button
			>
		{/each}
	</StatusBubble>
{/snippet}

{#snippet confirmation(item: StatusItem)}
	<div class="-translate-y-2">{@render status(item)}</div>
{/snippet}

{#if feedback?.urgent}
	{@render status(feedback)}
{:else if renderError}
	{@render status({
		message: renderError.message,
		urgent: true,
		actions: onRetryRender ? [{ label: 'Retry', run: onRetryRender }] : undefined
	})}
{:else if notice?.urgent}
	{@render confirmation(notice)}
{:else if saveAttention}
	{@render saveFeedback?.()}
{:else if notice}
	{@render confirmation(notice)}
{:else if saveCompletion}
	{@render saveFeedback?.()}
{:else if sourceStale}
	{@render status({
		message: 'The latest source updates are unavailable.'
	})}
{:else if feedback}
	{@render status(feedback)}
{/if}
