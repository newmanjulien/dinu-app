<script lang="ts">
	import type { FunctionReturnType } from 'convex/server';
	import type { api } from '../../../convex/_generated/api';
	import type { Role } from '../../../convex/permissions';
	import { buyerPath } from '$lib/buyer/urls';
	import type { Snippet } from 'svelte';
	import type { Id } from '../../../convex/_generated/dataModel';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	import QuestionIcon from 'phosphor-svelte/lib/QuestionIcon';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';

	let {
		role,
		links = [],
		initialLoading = true,
		activity,
		hasMore = false,
		loading = false,
		error = false,
		onShowMore,
		onRetry
	}: {
		role?: Role;
		initialLoading?: boolean;
		activity?: Snippet<[Id<'savedContracts'>]>;
		links?: FunctionReturnType<typeof api.buyerLinks.browse>['page'];
		hasMore?: boolean;
		loading?: boolean;
		error?: boolean;
		onShowMore?: () => void;
		onRetry?: () => void;
	} = $props();
</script>

<section
	aria-busy={initialLoading}
	inert={initialLoading}
	aria-labelledby="buyer-links-heading"
	class="min-w-0"
>
	<div class="mb-3 flex items-center gap-1.5">
		<h2 id="buyer-links-heading" class="text-[13.5px] font-medium">Buyer links</h2>
		{#if !initialLoading}<Tooltip
				label="About buyer links"
				text={role === 'admin'
					? 'These are the links that reps send to buyers. The explanations you added to the buyer template are displayed here.'
					: 'These are the links you send to buyers so they can understand and comment on your contract.'}
			>
				{#snippet children()}
					<QuestionIcon class="size-3.5 text-ink-muted/60" aria-hidden="true" />
				{/snippet}
			</Tooltip>{/if}
	</div>
	<div class="overflow-hidden rounded-xl border-hairline border-edge bg-surface shadow-card">
		{#each initialLoading ? Array.from({ length: 10 }, () => undefined) : links as link, index (link?.id ?? index)}
			<div class="relative border-edge/50" class:border-t={index > 0}>
				<svelte:element
					this={link ? 'a' : 'div'}
					href={link ? buyerPath(link.token) : undefined}
					target="_blank"
					rel="noopener noreferrer"
					aria-label={link
						? `Open buyer link for ${link.title}${link.hasUnreadComment ? '. Unread comment.' : ''} (opens in a new tab)`
						: undefined}
					class="flex flex-wrap items-center gap-x-2.5 gap-y-1 py-[9px] pr-[56px] pl-[11px] text-[13px] leading-5 font-normal break-words transition-colors hover:bg-field-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none"
				>
					<span class="min-w-0"
						>{#if link}{link.title} link{:else}<SkeletonBlock
								class="h-5 w-40 max-w-full"
							/>{/if}</span
					>
					{#if link?.hasUnreadComment}
						<span
							class="inline-flex shrink-0 items-center gap-1.5 rounded-full border-hairline border-edge bg-surface px-2 py-0.5 text-[11px] leading-4 font-normal text-ink"
						>
							<span aria-hidden="true" class="size-1.5 rounded-full bg-emerald-400"></span>
							Unread comment
						</span>
					{/if}
				</svelte:element>
				<div class="absolute inset-y-0 right-[11px] flex items-center">
					{#if link && activity}{@render activity(link.contractId)}{:else}<SkeletonBlock
							class="h-[18px] w-4 rounded-md"
						/>{/if}
				</div>
			</div>
		{/each}
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
</section>
