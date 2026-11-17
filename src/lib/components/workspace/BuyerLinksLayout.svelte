<script lang="ts">
	import type { FunctionReturnType } from 'convex/server';
	import type { api } from '../../../convex/_generated/api';
	import type { Role } from '../../../convex/permissions';
	import { buyerPath } from '$lib/buyer/urls';
	import type { Snippet } from 'svelte';
	import type { Id } from '../../../convex/_generated/dataModel';
	import QuestionIcon from 'phosphor-svelte/lib/QuestionIcon';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import Hint from '$lib/ui/Hint.svelte';

	let {
		role,
		showContent = true,
		showFirstLinkHint = false,
		onFirstLinkCardReady,
		unreadCurrent = true,
		links = [],
		emptyMessage,
		activity,
		hasMore = false,
		loading = false,
		error = false,
		onShowMore,
		onRetry
	}: {
		role?: Role;
		showContent?: boolean;
		showFirstLinkHint?: boolean;
		onFirstLinkCardReady?: () => void;
		unreadCurrent?: boolean;
		emptyMessage?: string;
		activity?: Snippet<[Id<'savedContracts'>]>;
		links?: FunctionReturnType<typeof api.buyerLinks.browse>['page'];
		hasMore?: boolean;
		loading?: boolean;
		error?: boolean;
		onShowMore?: () => void;
		onRetry?: () => void;
	} = $props();
	$effect(() => {
		if (showContent && links.length) onFirstLinkCardReady?.();
	});
</script>

<section aria-labelledby="buyer-links-heading" class="min-w-0">
	<div class="mb-3 flex items-center gap-1.5">
		<h2 id="buyer-links-heading" class="text-[13.5px] font-medium">Buyer links</h2>
		<Tooltip
			label="About buyer links"
			text={role === 'admin'
				? 'These are the links that reps send to buyers. The explanations you added to the buyer template are displayed here.'
				: 'These are the links you send to buyers so they can understand and comment on your contract.'}
		>
			{#snippet children()}
				<QuestionIcon class="size-3.5 text-ink-muted/60" aria-hidden="true" />
			{/snippet}
		</Tooltip>
	</div>
	{#if showContent && (links.length || emptyMessage || error || hasMore)}
		<div class="overflow-hidden rounded-xl border-hairline border-edge bg-surface shadow-card">
			{#each links as link, index (link.id)}
				<div class="relative border-edge/50" class:border-t={index > 0}>
					<a
						href={buyerPath(link.token)}
						target="_blank"
						rel="noopener noreferrer"
						aria-label={`Open buyer link for ${link.title}${unreadCurrent && link.hasUnreadComment ? '. Unread.' : ''} (opens in a new tab)`}
						class="flex flex-wrap items-center gap-x-2.5 gap-y-1 py-[9px] pr-[56px] pl-[11px] text-[13px] leading-5 font-normal break-words transition-colors hover:bg-field-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none"
					>
						<span class="min-w-0">{link.title} link</span>
						{#if unreadCurrent && link.hasUnreadComment}
							<span
								class="inline-flex shrink-0 items-center gap-1.5 rounded-full border-hairline border-edge bg-surface px-2 py-0.5 text-[11px] leading-4 font-normal text-ink"
							>
								<span aria-hidden="true" class="size-1.5 rounded-full bg-emerald-400"></span>
								Unread
							</span>
						{/if}
					</a>
					<div class="absolute inset-y-0 right-[11px] flex items-center">
						{@render activity?.(link.contractId)}
					</div>
				</div>
			{/each}
			{#if emptyMessage && !error}
				<p role="status" class="px-3.5 py-3 text-xs text-ink-muted">{emptyMessage}</p>
			{/if}
			{#if error}
				<p role="alert" class="border-t border-edge/50 px-3.5 py-3 text-xs text-ink-muted">
					We couldn’t refresh your buyer links. <button
						class="cursor-pointer underline"
						onclick={onRetry}>Try again</button
					>
				</p>
			{/if}
			{#if hasMore}
				<button
					type="button"
					onclick={onShowMore}
					disabled={loading || error}
					class="flex h-[35px] w-full cursor-pointer items-center justify-center border-t border-edge/50 text-[11.75px] text-ink-secondary transition-colors hover:bg-field-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-50 motion-reduce:transition-none"
					>{loading ? 'Loading…' : 'Show more'}</button
				>
			{/if}
		</div>
		{#if showFirstLinkHint}<Hint id="firstBuyerLink" class="mt-3" />{/if}
	{/if}
</section>
