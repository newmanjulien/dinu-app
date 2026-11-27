<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';
	import { useConvexClient } from 'convex-svelte';
	import type { Id } from '../../convex/_generated/dataModel';
	import { useViewer } from '$lib/auth/viewer-session.svelte';
	import { getContractEditors } from '$lib/contract/editors.svelte';
	import type { ContractBuyerLink } from '$lib/contract/saved';
	import { BuyerLinkController } from './links.svelte';
	import { getBuyerLinkCopyFeedback } from './copy-feedback.svelte';
	import Button from '$lib/ui/Button.svelte';
	import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
	import CircleNotchIcon from 'phosphor-svelte/lib/CircleNotchIcon';

	let {
		id,
		buyerLink,
		hasUnreadComment = false,
		mode = 'negotiate',
		onModeChange,
		onPreloadComments,
		disabled = false
	}: {
		id: Id<'savedContracts'>;
		buyerLink: ContractBuyerLink | null | undefined;
		hasUnreadComment?: boolean;
		mode?: 'negotiate' | 'comments';
		onModeChange?: (mode: 'negotiate' | 'comments') => void;
		onPreloadComments?: () => void;
		disabled?: boolean;
	} = $props();

	const membershipId = useViewer()().membership.id;
	const contractId = untrack(() => id);
	const links = new BuyerLinkController(
		useConvexClient(),
		getContractEditors(),
		membershipId,
		contractId,
		getBuyerLinkCopyFeedback().show,
		() => (buyerLink === undefined ? undefined : (buyerLink?.token ?? null))
	);

	let errorTimer: ReturnType<typeof setTimeout> | undefined;
	async function runLink(action: () => Promise<void>) {
		clearTimeout(errorTimer);
		await action();
		if (links.error) errorTimer = setTimeout(() => (links.error = null), 5000);
	}

	let element: HTMLElement;
	onMount(() => {
		const measure = () =>
			document.documentElement.style.setProperty(
				'--buyer-link-bar-height',
				`${element.getBoundingClientRect().height}px`
			);
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		measure();
		return () => {
			observer.disconnect();
			document.documentElement.style.removeProperty('--buyer-link-bar-height');
		};
	});
	onDestroy(() => {
		clearTimeout(errorTimer);
		links.destroy();
	});
</script>

<section
	bind:this={element}
	class="fixed inset-x-0 bottom-0 z-35 border-t-[length:var(--surface-border-width)] border-line bg-surface px-3 pt-[8px] pb-[calc(8px+env(safe-area-inset-bottom))] shadow-floating"
	aria-label="Buyer link"
>
	<div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
		{#if buyerLink}
			<div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
				<div
					role="group"
					aria-label="Contract view"
					class="inline-flex items-center rounded-button-lg border-hairline border-edge bg-canvas p-0.5"
				>
					<button
						type="button"
						aria-pressed={mode === 'negotiate'}
						onclick={() => onModeChange?.('negotiate')}
						class={[
							'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-button px-2.5 text-[13px] font-normal transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
							mode === 'negotiate'
								? 'bg-surface text-ink shadow-control'
								: 'text-ink-muted hover:text-ink'
						]}
					>
						Negotiate
					</button>
					<button
						type="button"
						aria-pressed={mode === 'comments'}
						onpointerenter={() => onPreloadComments?.()}
						onfocus={() => onPreloadComments?.()}
						onclick={() => onModeChange?.('comments')}
						class={[
							'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-button px-2.5 text-[13px] font-normal transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
							mode === 'comments'
								? 'bg-surface text-ink shadow-control'
								: 'text-ink-muted hover:text-ink'
						]}
					>
						<span>Comments</span>
						{#if hasUnreadComment}
							<span class="size-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden="true"></span>
							<span class="sr-only"> (unread)</span>
						{/if}
					</button>
				</div>
				{#if links.error}
					<p role="alert" class="min-w-0 text-[13px] text-danger">{links.error}</p>
				{/if}
			</div>
		{:else}
			<p
				role={links.error ? 'alert' : undefined}
				class={`min-w-0 flex-1 basis-72 text-[13.5px] ${links.error ? 'text-danger' : 'text-ink-muted'}`}
			>
				{#if links.error}{links.error}
				{:else if buyerLink === null}Create a link to share this contract with the buyer.
				{/if}
			</p>
		{/if}
		<div class="flex items-center gap-2" data-buyer-link-actions>
			<Button
				variant="secondary"
				disabled={(!buyerLink && disabled) || Boolean(links.busy) || buyerLink === undefined}
				onclick={() => void runLink(() => links.copy())}
			>
				{#if links.busy}<CircleNotchIcon
						class="size-[15px] shrink-0 animate-spin"
						aria-hidden="true"
					/>{:else}<LinkIcon class="size-[15px] shrink-0" aria-hidden="true" />{/if}
				<span class="inline-grid place-items-center">
					<span aria-hidden="true" class="invisible col-start-1 row-start-1">Create link</span>
					<span class="col-start-1 row-start-1">{buyerLink ? 'Copy link' : 'Create link'}</span>
				</span>
				{#if links.busy}<span class="sr-only" role="status">{links.busy}</span>{/if}
			</Button>
		</div>
	</div>
</section>
