<script lang="ts">
	import { untrack } from 'svelte';
	import { rendering } from './rendering.svelte';
	import type { ContractEditor } from '../../src/lib/contract/editors.svelte';
	import type { Id } from '../../src/convex/_generated/dataModel';
	let {
		editor,
		onVisible
	}: {
		editor: ContractEditor;
		onVisible?: () => void;
		snapshot?: unknown;
		onFailure?: () => void;
	} = $props();
	$effect(() => {
		if (rendering.ready) untrack(() => onVisible?.());
	});
</script>

<div aria-label="Contract viewer">{JSON.stringify(editor.persistence?.choices)}</div>
<button onclick={() => editor.persistence?.select('item-a' as Id<'playbookItems'>, 'preferred')}
	>Select concession</button
>
