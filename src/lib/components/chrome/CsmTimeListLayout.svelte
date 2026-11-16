<script lang="ts">
	import type { Snippet } from 'svelte';
	let {
		loading = false,
		timeZoneId,
		children,
		timeZoneControl,
		timeZoneLabel
	}: {
		loading?: boolean;
		timeZoneId: string;
		children: Snippet;
		timeZoneControl: Snippet;
		timeZoneLabel?: Snippet;
	} = $props();
</script>

<div class="mt-5 rounded-base border-hairline border-line bg-surface text-ink" aria-busy={loading}>
	<div class="max-h-80 overflow-y-auto p-3 [scrollbar-gutter:stable] @max-[290px]:px-2">
		{@render children()}
	</div>
	<div
		class="flex min-w-0 items-center gap-2.5 border-t-[length:var(--surface-border-width)] border-line p-3 @max-[290px]:flex-col @max-[290px]:items-stretch @max-[290px]:gap-1 @max-[290px]:px-2"
	>
		{#if timeZoneLabel}{@render timeZoneLabel()}{:else}<label
				for={timeZoneId}
				class="shrink-0 text-[12px] text-ink-muted">Time zone</label
			>{/if}
		<div class="relative min-w-0 flex-1">{@render timeZoneControl()}</div>
	</div>
</div>
