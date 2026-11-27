<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Role } from '../../../convex/permissions';
	import QuestionIcon from 'phosphor-svelte/lib/QuestionIcon';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import LoadingWheel from '$lib/ui/LoadingWheel.svelte';
	let {
		role,
		showContent = true,
		loading = false,
		notice,
		contracts
	}: {
		role?: Role;
		showContent?: boolean;
		loading?: boolean;
		notice?: Snippet;
		contracts?: Snippet;
	} = $props();
</script>

{@render notice?.()}
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
	{:else}
		<div class="flex min-h-40 items-center justify-center">
			<LoadingWheel class="size-5" label="Loading contract results" />
		</div>
	{/if}
</section>
