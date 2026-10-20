<script lang="ts">
	import type { Snippet } from 'svelte';

	let { title, description, children }: { title: string; description: string; children: Snippet } =
		$props();
</script>

<h1 class="m-0 text-[30px] font-medium leading-[1.08] tracking-[-0.02em] text-[#08090a]">
	{title}
</h1>
<p class="mx-auto mt-4 max-w-sm text-sm leading-[1.45] text-[#686b73]">
	{description}
</p>

<div class="mt-10">
	{@render children()}
</div>
