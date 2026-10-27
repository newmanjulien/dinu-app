<script lang="ts">
	import type { OperationStatus as StatusItem } from './operation-status';
	import type { RenderFailure } from '$lib/document/runtime/types';

	let {
		feedback = null,
		renderPending = false,
		renderError = null,
		sourceStale = false,
		onRetryRender
	}: {
		feedback?: StatusItem | null;
		renderPending?: boolean;
		renderError?: RenderFailure | null;
		sourceStale?: boolean;
		onRetryRender?: () => void;
	} = $props();
	// Presentation only. Pending generations do not reset the delay during a burst.
	let showUpdating = $state(false);
	$effect(() => {
		showUpdating = false;
		if (!renderPending) return;
		const timer = setTimeout(() => {
			showUpdating = true;
		}, 250);
		return () => clearTimeout(timer);
	});
	const updating = $derived(renderPending && showUpdating && !renderError);
</script>

{#snippet status(item: StatusItem)}
	<div
		class="pointer-events-none rounded-xl border-hairline border-edge bg-surface px-2.5 py-1.5 text-[14px] leading-5 text-ink-secondary shadow-floating max-[999px]:w-full max-[999px]:px-3 max-[999px]:py-1 max-[999px]:text-sm"
		role={item.urgent ? 'alert' : 'status'}
	>
		{item.message}
		{#each item.actions ?? [] as action}
			<button
				type="button"
				class="pointer-events-auto ml-2 cursor-pointer font-medium text-accent underline"
				onclick={action.run}>{action.label}</button
			>
		{/each}
	</div>
{/snippet}

{#if feedback?.urgent}{@render status(feedback)}{/if}
{#if renderError}
	{@render status({
		message: `${renderError.message} Showing the last successfully rendered contract.`,
		urgent: true,
		actions: onRetryRender ? [{ label: 'Retry', run: onRetryRender }] : undefined
	})}
{/if}
{#if sourceStale}
	{@render status({
		message: 'The latest source updates are unavailable. Your current contract is kept.'
	})}
{/if}
{#if feedback && !feedback.urgent}{@render status(feedback)}{/if}
{#if updating}{@render status({ message: 'Updating contract…' })}{/if}
