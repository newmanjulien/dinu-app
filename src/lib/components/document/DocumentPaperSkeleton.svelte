<script lang="ts">
	import { PAGE_FORMAT } from '$lib/document/pagination/page-format';
	let {
		label = 'Preparing document pages',
		announce = true
	}: { label?: string; announce?: boolean } = $props();
</script>

{#if announce}<span role="status" class="sr-only">{label}</span>{/if}
<div
	data-testid="pagination-loading"
	aria-hidden="true"
	class="aspect-(--paper-ratio) w-full bg-surface shadow-card outline-(length:--surface-border-width) outline-edge outline-offset-[calc(-1*var(--surface-border-width))]"
	style:--paper-ratio={`${PAGE_FORMAT.width} / ${PAGE_FORMAT.height}`}
></div>
