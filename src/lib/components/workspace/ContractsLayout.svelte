<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Role } from '../../../convex/permissions';
	import SearchField from '$lib/ui/SearchField.svelte';
	import Button from '$lib/ui/Button.svelte';
	import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
	import QuestionIcon from 'phosphor-svelte/lib/QuestionIcon';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import ContractGridSkeleton from './ContractGridSkeleton.svelte';
	import BuyerLinksSkeleton from './BuyerLinksSkeleton.svelte';
	let {
		role,
		hasBuyerLinks = false,
		toolbar,
		notice,
		contracts,
		buyerLinksContent
	}: {
		role?: Role;
		hasBuyerLinks?: boolean;
		toolbar?: Snippet;
		notice?: Snippet;
		contracts?: Snippet;
		buyerLinksContent?: Snippet;
	} = $props();
</script>

<main
	class="contracts min-h-[calc(100dvh-var(--app-header-height))] bg-page px-4 py-4 sm:px-6 md:px-8 md:py-5"
	aria-busy={!contracts}
>
	<div class="mx-auto max-w-[1800px]">
		<h1 class="sr-only">Contracts</h1>
		<div class="mb-6 flex items-center gap-2">
			{#if toolbar}{@render toolbar()}{:else}
				<SearchField label="Search contracts" placeholder="Search by name of company" disabled />
				<Button disabled><PlusIcon class="size-[15px]" aria-hidden="true" />New contract</Button>
			{/if}
		</div>
		{@render notice?.()}
		{#if role}
			<div
				class={hasBuyerLinks
					? 'grid grid-cols-1 items-start gap-6 min-[1000px]:grid-cols-[minmax(0,1fr)_450px]'
					: ''}
			>
				<section aria-labelledby="contracts-heading" class="min-w-0 @container">
					<div class="mb-3 flex items-center gap-1.5">
						<h2 id="contracts-heading" class="text-[13.5px] font-medium">Contracts</h2>
						{#if contracts}<Tooltip
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

					{#if contracts}{@render contracts()}{:else}<ContractGridSkeleton announce={false} />{/if}
				</section>
				{#if buyerLinksContent}{@render buyerLinksContent()}{:else if hasBuyerLinks}<BuyerLinksSkeleton
					/>{/if}
			</div>
		{/if}
	</div>
</main>
