<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Role } from '../../../convex/permissions';
	import { afterStartupPaint } from '$lib/auth/startup-perf';
	import QuestionIcon from 'phosphor-svelte/lib/QuestionIcon';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import LoadingWheel from '$lib/ui/LoadingWheel.svelte';
	let {
		role,
		hasBuyerLinks = false,
		firstVisit = false,
		showContent = true,
		loading = false,
		notice,
		contracts,
		buyerLinksContent
	}: {
		role?: Role;
		hasBuyerLinks?: boolean;
		firstVisit?: boolean;
		showContent?: boolean;
		loading?: boolean;
		notice?: Snippet;
		contracts?: Snippet;
		buyerLinksContent?: Snippet<[boolean]>;
	} = $props();
	// When links arrive after a cold entry, paint their heading before revealing the rows.
	let buyerHeadingPainted = $state(false);
	$effect(() => {
		if (!firstVisit || buyerHeadingPainted || !hasBuyerLinks) return;
		return afterStartupPaint(() => (buyerHeadingPainted = true));
	});
	const showBuyerContent = $derived(
		showContent && !loading && (!firstVisit || buyerHeadingPainted)
	);
</script>

{@render notice?.()}
<div
	class={hasBuyerLinks
		? 'grid grid-cols-1 items-start gap-6 min-[1000px]:grid-cols-[minmax(0,1fr)_355px]'
		: ''}
>
	<section aria-labelledby="contracts-heading" class="min-w-0 @container">
		<div class="mb-3 flex items-center gap-1.5">
			<h2 id="contracts-heading" class="text-[13.5px] font-medium">Contracts</h2>
			{#if contracts && role}<Tooltip
					label="About contracts"
					text={role === 'admin'
						? 'This is where reps will see your instructions and make the concessions you set up.'
						: 'This is where see instructions on how to negotiate contracts and where you make pre-approved concessions.'}
				>
					{#snippet children()}
						<QuestionIcon class="size-3.5 text-ink-muted/60" aria-hidden="true" />
					{/snippet}
				</Tooltip>{/if}
		</div>

		{#if showContent && !loading}
			{@render contracts?.()}
		{/if}
	</section>
	{@render buyerLinksContent?.(showBuyerContent)}
	{#if loading || !showContent}
		<div class="col-span-full flex min-h-40 items-center justify-center">
			<LoadingWheel class="size-5" label="Loading contract results" />
		</div>
	{/if}
</div>
