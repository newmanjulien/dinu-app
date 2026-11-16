<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';
	import { useConvexClient } from 'convex-svelte';
	import { api } from '../../convex/_generated/api';
	import type { Id } from '../../convex/_generated/dataModel';
	import { useViewer } from '$lib/auth/viewer-session.svelte';
	import type { useReadQuery } from '$lib/auth/read-query.svelte';
	import { getContractEditors } from '$lib/contract/editors.svelte';
	import { BuyerLinkController } from './links.svelte';
	import { getBuyerLinkCopyFeedback } from './copy-feedback.svelte';
	import { buyerPath } from './urls';
	import Button from '$lib/ui/Button.svelte';
	import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
	import CircleNotchIcon from 'phosphor-svelte/lib/CircleNotchIcon';
	let {
		id,
		latest
	}: {
		id: Id<'savedContracts'>;
		latest: ReturnType<typeof useReadQuery<typeof api.buyerLinks.latest>>;
	} = $props();
	const membershipId = useViewer()().membership.id;
	const contractId = untrack(() => id);
	const links = new BuyerLinkController(
		useConvexClient(),
		getContractEditors(),
		membershipId,
		contractId,
		getBuyerLinkCopyFeedback().show
	);
	let errorTimer: ReturnType<typeof setTimeout> | undefined;
	let statusFailed = $state(false);
	const error = $derived(
		links.error ??
			(latest.error || statusFailed ? 'We couldn’t check the buyer link. Please try again.' : null)
	);
	$effect(() => {
		if (latest.error) statusFailed = true;
		else if (!latest.isLoading && latest.data !== undefined) statusFailed = false;
	});
	function retryStatus() {
		latest.retry();
	}
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
	<div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
		<p
			role={error ? 'alert' : undefined}
			class={`min-w-0 flex-1 basis-72 text-[13.5px] ${error ? 'text-danger' : 'text-ink-muted'}`}
		>
			{#if error}{error}
			{:else if latest.data}
				<a
					href={buyerPath(latest.data.token)}
					target="_blank"
					rel="noopener noreferrer"
					class="cursor-pointer text-accent underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
					>Open link</a
				>
				to leave comments on this contract.
			{:else if latest.data === null}Create a link to share this contract with the buyer.
			{/if}
		</p>
		<Button
			variant="secondary"
			disabled={Boolean(links.busy) || latest.isLoading}
			onclick={() =>
				latest.error || statusFailed ? retryStatus() : void runLink(() => links.copy())}
			>{#if links.busy}<CircleNotchIcon
					class="size-[15px] shrink-0 animate-spin"
					aria-hidden="true"
				/>{:else}<LinkIcon class="size-[15px] shrink-0" aria-hidden="true" />{/if}
			<span class="inline-grid place-items-center">
				<span aria-hidden="true" class="invisible col-start-1 row-start-1">Create link</span>
				<span class="col-start-1 row-start-1"
					>{latest.error || statusFailed
						? 'Retry'
						: latest.data
							? 'Copy link'
							: 'Create link'}</span
				>
			</span>
			{#if links.busy}<span class="sr-only" role="status">{links.busy}</span>{/if}</Button
		>
	</div>
</section>
