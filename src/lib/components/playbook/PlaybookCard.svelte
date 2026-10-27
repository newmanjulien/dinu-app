<script lang="ts">
	import type { Snippet } from 'svelte';
	let { children, label }: { children: Snippet; label: string } = $props();
</script>

<aside
	aria-label={label}
	class="flex min-w-0 w-full flex-col gap-3 [&>*]:min-w-0 [&>*]:w-full [&>*]:shrink-0 rounded-base border-hairline border-edge bg-surface p-3.5 text-[14px] leading-[1.45] text-ink shadow-card @max-[1150px]:shadow-none @max-[1150px]:max-h-[min(65dvh,560px)] @max-[1150px]:overflow-y-auto @max-[1150px]:overscroll-contain @max-[1150px]:rounded-b-none @max-[1150px]:border-x-0 @max-[1150px]:border-b-0 @max-[1150px]:pt-3 @max-[1150px]:pb-[calc(12px+env(safe-area-inset-bottom))] @max-[1150px]:has-[>_:nth-child(2)]:pb-[calc(14px+env(safe-area-inset-bottom))]"
>
	{@render children()}
</aside>
