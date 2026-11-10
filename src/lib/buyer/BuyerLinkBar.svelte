<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';
	import { useConvexClient } from 'convex-svelte';
	import { api } from '../../convex/_generated/api';
	import type { Id } from '../../convex/_generated/dataModel';
	import { useViewer } from '$lib/auth/viewer-session.svelte';
	import { useReadQuery } from '$lib/auth/read-query.svelte';
	import { getContractEditors } from '$lib/contract/editors.svelte';
	import { BuyerLinkController } from './links.svelte';
	import { getBuyerLinkCopyFeedback } from './copy-feedback.svelte';
	import Button from '$lib/ui/Button.svelte';
	import TextInput from '$lib/ui/TextInput.svelte';
	import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
	let { id, recipientName }: { id: Id<'savedContracts'>; recipientName: string } = $props();
	const membershipId = useViewer()().membership.id;
	const contractId = untrack(() => id);
	const links = new BuyerLinkController(
		useConvexClient(),
		getContractEditors(),
		membershipId,
		contractId,
		getBuyerLinkCopyFeedback().show
	);
	const latest = useReadQuery(api.buyerLinks.latest, { membershipId, id: contractId });
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
	onDestroy(() => links.destroy());
</script>

<section
	bind:this={element}
	class="fixed inset-x-0 bottom-0 z-35 border-t-[length:var(--surface-border-width)] border-line bg-surface px-3 pt-[9px] pb-[calc(9px+env(safe-area-inset-bottom))] shadow-floating"
	aria-label="Buyer link"
>
	<div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
		<p class="min-w-0 flex-1 basis-72 text-[13px] leading-relaxed text-ink-muted">
			{#if latest.data}This contract has been published to {recipientName}. Approved changes will be
				visible to them.
			{:else}Create a link and send it to {recipientName}.{/if}
		</p>
		<Button variant="secondary" disabled={Boolean(links.busy)} onclick={() => void links.copy()}
			><LinkIcon class="size-[15px] shrink-0" aria-hidden="true" />{links.busy ??
				(latest.data ? 'Copy link' : 'Create link')}</Button
		>
	</div>
	{#if links.error || links.manualUrl}<p
			role={links.error ? 'alert' : 'status'}
			class="mt-2 text-xs text-ink-muted"
		>
			{links.error ?? 'Copy this link to send it to the buyer.'}
		</p>{/if}
	{#if links.manualUrl}<TextInput
			readonly
			aria-label="Buyer link"
			value={links.manualUrl}
			onfocus={(event) => event.currentTarget.select()}
			class="mt-2"
		/>{/if}
</section>
