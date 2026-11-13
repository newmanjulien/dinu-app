<script lang="ts">
	import type { Snippet } from 'svelte';
	import { grid } from './csm-calendar';
	let {
		month,
		selectedDate,
		labelledBy,
		loading = false,
		element = $bindable(),
		day
	}: {
		month: string;
		selectedDate?: string;
		labelledBy: string;
		loading?: boolean;
		element?: HTMLTableElement;
		day: Snippet<[string]>;
	} = $props();
	const rows = $derived(grid(month));
</script>

<table
	bind:this={element}
	role="grid"
	aria-labelledby={labelledBy}
	aria-hidden={loading || undefined}
	class="w-full table-fixed border-separate border-spacing-0 text-center"
>
	<thead
		><tr
			>{#each ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as day}<th
					scope="col"
					class="h-[31px] text-[12px] font-normal text-ink-muted"
					><span aria-label={day}>{day.slice(0, 1)}</span></th
				>{/each}</tr
		></thead
	>
	<tbody
		>{#each rows as week}<tr
				>{#each week as date}<td
						role="gridcell"
						aria-selected={selectedDate === date}
						class="p-0.5"
					>
						{@render day(date)}
					</td>{/each}</tr
			>{/each}</tbody
	>
</table>
