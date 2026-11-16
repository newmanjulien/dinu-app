<script lang="ts">
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	import type { AvailabilitySelection } from './csm-availability';
	import CsmBookingLayout from './CsmBookingLayout.svelte';
	import CsmTimeListLayout from './CsmTimeListLayout.svelte';
	let { description, initial }: { description: string; initial: AvailabilitySelection } = $props();
	const id = $props.id();
</script>

<CsmBookingLayout {description} headingId={id} loading>
	<span role="status" class="sr-only">Loading available times</span>
	<CsmTimeListLayout loading timeZoneId={id + '-zone'}>
		<div class="space-y-1.5" aria-hidden="true">
			<SkeletonBlock class="mb-3 h-5 w-32" />
			{#each [0, 1, 2, 3] as slot (slot)}<SkeletonBlock
					class="h-button-sm w-full rounded-button-lg"
				/>{/each}
		</div>
		{#snippet timeZoneLabel()}<span class="shrink-0 text-[12px] text-ink-muted">Time zone</span
			>{/snippet}
		{#snippet timeZoneControl()}<p
				id={id + '-zone'}
				class="flex min-h-9 items-center text-[12.5px] text-ink-muted"
			>
				{initial.timeZone.replaceAll('_', ' ')}
			</p>{/snippet}
	</CsmTimeListLayout>
</CsmBookingLayout>
