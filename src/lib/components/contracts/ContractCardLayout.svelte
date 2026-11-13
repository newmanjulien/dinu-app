<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Action } from 'svelte/action';
	import type { SavedContractCard } from '$lib/contract/card';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	let {
		contract,
		observe = () => {},
		onWarm,
		onCool,
		content,
		action,
		skeletonIndex
	}: {
		contract?: SavedContractCard;
		observe?: Action<HTMLElement, SavedContractCard>;
		onWarm?: () => void;
		onCool?: () => void;
		content?: Snippet;
		action?: Snippet;
		skeletonIndex?: number;
	} = $props();
	let hovered = false;
	let focused = false;
	const observeCard: Action<HTMLElement, SavedContractCard | undefined> = (node, card) => {
		const observation = card ? observe(node, card) : undefined;
		return {
			update(next) {
				if (next) observation?.update?.(next);
			},
			destroy() {
				observation?.destroy?.();
			}
		};
	};
</script>

<article
	use:observeCard={contract}
	aria-hidden={!contract}
	class={[
		'relative flex min-w-0 flex-col rounded-xl border-hairline border-edge bg-surface shadow-card transition-colors hover:bg-field-hover',
		skeletonIndex !== undefined
			? skeletonIndex >= 8
				? 'hidden @[1000px]:flex'
				: skeletonIndex >= 4
					? 'hidden @[600px]:flex'
					: ''
			: ''
	]}
>
	<svelte:element
		this={contract ? 'a' : 'div'}
		role={contract ? 'link' : undefined}
		href={contract ? `/contracts/${contract._id}` : undefined}
		data-contract-destination={contract?._id}
		data-sveltekit-preload-data="off"
		onmouseenter={() => {
			hovered = true;
			onWarm?.();
		}}
		onfocus={() => {
			focused = true;
			onWarm?.();
		}}
		onmouseleave={() => {
			hovered = false;
			if (!focused) onCool?.();
		}}
		onblur={() => {
			focused = false;
			if (!hovered) onCool?.();
		}}
		class="flex flex-1 flex-col justify-between gap-1.5 rounded-xl py-[9px] pr-[56px] pl-[11px] outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-1 focus-visible:after:ring-accent"
		aria-label={contract ? `Open contract for ${contract.title}` : undefined}
	>
		{#if content}{@render content()}{:else}
			<SkeletonBlock class="h-5 w-3/4" />
			<div class="flex min-w-0 items-center gap-2 text-xs text-ink-muted">
				<SkeletonBlock class="size-5 rounded-full" /><SkeletonBlock class="h-4 w-1/3" />
			</div>
			<SkeletonBlock class="h-4 w-2/3" />
		{/if}
	</svelte:element>
	<div class="absolute top-[9px] right-[11px] z-10 inline-flex items-center">
		{#if action}{@render action()}{:else}<SkeletonBlock class="size-6 rounded-full" />{/if}
	</div>
</article>
