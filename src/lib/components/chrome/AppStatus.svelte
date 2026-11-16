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
		saveFeedback
	}: {
		feedback?: StatusItem | null;
		renderError?: RenderFailure | null;
		sourceStale?: boolean;
		onRetryRender?: () => void;
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

{#if feedback?.urgent}{@render status(feedback)}{/if}
{#if renderError}
	{@render status({
		message: renderError.message,
		urgent: true,
		actions: onRetryRender ? [{ label: 'Retry', run: onRetryRender }] : undefined
	})}
{/if}
{#if sourceStale}
	{@render status({
		message: 'The latest source updates are unavailable.'
	})}
{/if}
{@render saveFeedback?.()}
{#if feedback && !feedback.urgent}{@render status(feedback)}{/if}
