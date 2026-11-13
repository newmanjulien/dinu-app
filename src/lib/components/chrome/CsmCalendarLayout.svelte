<script lang="ts">
	import type { Snippet } from 'svelte';
	let {
		loading = false,
		monthHeadingId,
		timeZoneId,
		monthTitle,
		monthNavigation,
		dates,
		timesTitle,
		times,
		timeZoneLabel,
		timeZoneControl
	}: {
		loading?: boolean;
		monthHeadingId: string;
		timeZoneId: string;
		monthTitle: Snippet;
		monthNavigation: Snippet;
		dates: Snippet;
		timesTitle: Snippet;
		times: Snippet;
		timeZoneLabel?: Snippet;
		timeZoneControl: Snippet;
	} = $props();
</script>

<div
	class="mt-5 grid grid-cols-1 rounded-base border-hairline border-line bg-surface text-ink @min-[520px]:grid-cols-[minmax(0,1fr)_232px]"
	aria-busy={loading}
>
	<div class="min-w-0 p-3 @max-[290px]:px-2">
		<div class="mb-2 flex items-center justify-between gap-2">
			<h4 id={monthHeadingId} class="text-[14px] font-medium">{@render monthTitle()}</h4>
			<div class="flex gap-1">{@render monthNavigation()}</div>
		</div>
		{@render dates()}
	</div>
	<div
		class="flex min-w-0 flex-col border-t-[length:var(--surface-border-width)] border-line p-3 @min-[520px]:col-start-2 @min-[520px]:row-start-1 @min-[520px]:min-h-0 @min-[520px]:border-t-0 @min-[520px]:border-l-[length:var(--surface-border-width)] @min-[520px]:[contain:size] @max-[290px]:px-2"
	>
		<h4 class="mb-2 flex min-h-[31px] shrink-0 items-center text-[14px] font-medium">
			{@render timesTitle()}
		</h4>
		<div
			class="-m-0.5 min-h-0 max-h-37 overflow-y-auto p-0.5 [scrollbar-gutter:stable] @min-[520px]:max-h-none"
		>
			{@render times()}
		</div>
	</div>
	<div
		class="col-span-full flex min-w-0 items-center gap-2.5 border-t-[length:var(--surface-border-width)] border-line p-3 @min-[520px]:row-start-2 @max-[290px]:flex-col @max-[290px]:items-stretch @max-[290px]:gap-1 @max-[290px]:px-2"
	>
		{#if timeZoneLabel}{@render timeZoneLabel()}{:else}<label
				for={timeZoneId}
				class="shrink-0 text-[12px] text-ink-muted">Time zone</label
			>{/if}
		<div class="relative min-w-0 flex-1">{@render timeZoneControl()}</div>
	</div>
</div>
