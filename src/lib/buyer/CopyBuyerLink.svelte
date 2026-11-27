<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { useConvexClient } from 'convex-svelte';
	import { useViewer } from '$lib/auth/viewer-session.svelte';
	import { getContractEditors } from '$lib/contract/editors.svelte';
	import { BuyerLinkController } from './links.svelte';
	import type { Id } from '../../convex/_generated/dataModel';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import { getBuyerLinkCopyFeedback } from './copy-feedback.svelte';
	let {
		id,
		token,
		disabled = false,
		reason = null
	}: {
		id: Id<'savedContracts'>;
		token?: string | null;
		disabled?: boolean;
		reason?: string | null;
	} = $props();
	const viewer = useViewer();
	const feedback = getBuyerLinkCopyFeedback();
	const links = new BuyerLinkController(
		useConvexClient(),
		getContractEditors(),
		viewer().membership.id,
		untrack(() => id),
		feedback.show,
		() => token
	);
	onDestroy(() => links.destroy());
	let trigger = $state<HTMLButtonElement | null>();
</script>

<Tooltip
	text={reason ?? links.busy ?? 'Copy and send to buyer'}
	trigger={trigger ?? undefined}
	standalone={false}
>
	{#snippet children(descriptionId)}
		<button
			bind:this={trigger}
			type="button"
			class="group/buyer-link inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-ink-secondary transition-colors hover:bg-field-hover hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:text-ink-muted disabled:hover:bg-transparent aria-disabled:cursor-default aria-disabled:text-ink-muted aria-disabled:hover:bg-transparent"
			aria-label="Copy buyer link"
			aria-busy={Boolean(links.busy)}
			disabled={disabled || Boolean(links.busy)}
			aria-disabled={Boolean(reason)}
			aria-describedby={descriptionId}
			onclick={() => {
				if (disabled || reason || links.busy) return;
				void links.copy().then(() => {
					if (links.error) feedback.showError(links.error);
				});
			}}
		>
			{#if links.busy}
				<svg
					class="size-[13px] shrink-0 motion-safe:animate-spin"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					aria-hidden="true"
				>
					<circle class="opacity-25" cx="12" cy="12" r="9" />
					<path stroke-linecap="round" d="M12 3a9 9 0 0 1 9 9" />
				</svg>
			{:else}
				<svg
					class="size-[13px] shrink-0 motion-safe:group-hover/buyer-link:animate-[buyer-link-rock_600ms_ease-in-out] motion-safe:group-focus-visible/buyer-link:animate-[buyer-link-rock_600ms_ease-in-out]"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.75"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
					<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
				</svg>
			{/if}
		</button>
	{/snippet}
</Tooltip>
<span class="sr-only" aria-live="polite">{links.busy}</span>

<style>
	@keyframes -global-buyer-link-rock {
		0%,
		100% {
			transform: rotate(0);
		}
		30% {
			transform: rotate(-10deg);
		}
		65% {
			transform: rotate(7deg);
		}
	}
</style>
