<script lang="ts">
	import LoadingWheel from '$lib/ui/LoadingWheel.svelte';
	let { announce = true }: { announce?: boolean } = $props();
</script>

<div
	class="flex items-center gap-2 py-4 text-[13px] text-ink-muted"
	role={announce ? 'status' : undefined}
>
	<span aria-hidden="true"><LoadingWheel class="size-4" /></span>
	<span>Loading contracts…</span>
</div>
