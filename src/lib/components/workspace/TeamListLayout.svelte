<script lang="ts">
	import type { Snippet } from 'svelte';
	let { children, loading = false }: { children: Snippet; loading?: boolean } = $props();
</script>

<ul
	aria-busy={loading}
	aria-hidden={loading ? true : undefined}
	class="divide-y-[length:var(--surface-border-width)] divide-line rounded-xl border-hairline border-edge bg-surface shadow-card"
>
	{@render children()}
</ul>
