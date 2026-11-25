<script lang="ts">
	import type { Snippet } from 'svelte';
	let { urgent = false, children }: { urgent?: boolean; children: Snippet } = $props();
</script>

<div
	class="pointer-events-none rounded-xl border-hairline border-edge bg-surface px-2 py-1 text-[13px] leading-5 text-ink-secondary shadow-floating max-[999px]:w-full max-[999px]:px-2.5 max-[999px]:py-1"
	role={urgent ? 'alert' : 'status'}
>
	{@render children()}
</div>
