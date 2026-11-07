<script lang="ts">
	// Only geometry/pagination is substituted. The workspace, panel, editor and selection session are real.
	import { onMount } from 'svelte';
	import { getContractWorkspace } from '../../src/lib/document/runtime/workspace-context';
	import type { ViewerBindings } from '../../src/lib/document/runtime/resources.svelte';
	import { documentAnnotations } from '../../src/lib/playbook/document-overlay';
	let { panelContent, onSelect }: ViewerBindings = $props();
	const { source, viewer } = getContractWorkspace();
	onMount(() => {
		viewer.layoutPrepared = true;
		viewer.interactionEnabled = true;
	});
</script>

<div aria-label="Document surface">
	{#each source.structuralItems ?? [] as item}
		<button onclick={() => onSelect(item._id, documentAnnotations(item)[0].id)}
			>Open {item._id}</button
		>
	{/each}
</div>
<output aria-label="Pending annotation"
	>{source.annotations.some((item) => item.annotations.some((annotation) => annotation.pending))
		? 'pending'
		: 'settled'}</output
>
{@render panelContent()}
