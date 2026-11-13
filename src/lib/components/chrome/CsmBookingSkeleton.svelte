<script lang="ts">
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeftIcon';
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
	import { dateLabel } from './csm-calendar';
	import IconButton from '$lib/ui/IconButton.svelte';
	import CsmBookingLayout from './CsmBookingLayout.svelte';
	import CsmCalendarLayout from './CsmCalendarLayout.svelte';
	import CsmCalendarDates from './CsmCalendarDates.svelte';
	let { description, month }: { description: string; month: string } = $props();
	const id = $props.id();
</script>

<CsmBookingLayout {description} headingId={id} loading>
	<span role="status" class="sr-only">Loading calendar</span>
	<CsmCalendarLayout loading monthHeadingId={id + '-month'} timeZoneId={id + '-zone'}>
		{#snippet monthTitle()}{dateLabel(month + '-01', { month: 'long', year: 'numeric' })}{/snippet}
		{#snippet monthNavigation()}<IconButton variant="ghost" aria-label="Previous month" disabled
				><CaretLeftIcon class="size-4" aria-hidden="true" /></IconButton
			><IconButton variant="ghost" aria-label="Next month" disabled
				><CaretRightIcon class="size-4" aria-hidden="true" /></IconButton
			>{/snippet}
		{#snippet dates()}<CsmCalendarDates {month} labelledBy={id + '-month'} loading
				>{#snippet day(date)}{#if date.startsWith(month)}<SkeletonBlock
							class="h-[31px] w-full rounded-button-md"
						/>{:else}<span class="block h-[31px]" aria-hidden="true"
						></span>{/if}{/snippet}</CsmCalendarDates
			>{/snippet}
		{#snippet timesTitle()}<SkeletonBlock as="span" class="h-5 w-28" />{/snippet}
		{#snippet times()}<div class="space-y-1.5">
				{#each [0, 1, 2, 3] as slot (slot)}<SkeletonBlock
						class="h-button-sm w-full rounded-button-lg"
					/>{/each}
			</div>{/snippet}
		{#snippet timeZoneControl()}<SkeletonBlock class="h-9 w-full rounded-button-lg" />{/snippet}
	</CsmCalendarLayout>
</CsmBookingLayout>
