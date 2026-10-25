<script module lang="ts">
	export { createContractWorkspace } from '$lib/document/runtime/context';
</script>

<script lang="ts">
	import RetainedViewer from '$lib/components/document/RetainedViewer.svelte';
	import LayoutProfileSurface from '$lib/components/document/LayoutProfileSurface.svelte';
	import type { ContractLayoutProfiles } from '$lib/document/runtime/layout-context.svelte';
	import type { DocumentResources } from '$lib/document/runtime/resources.svelte';
	let {
		profiles,
		resources,
		paused = false
	}: {
		profiles?: ContractLayoutProfiles;
		resources?: DocumentResources;
		paused?: boolean;
	} = $props();
</script>

{#if profiles}<LayoutProfileSurface bind:surface={profiles.surface} />{/if}
{#if resources}{#each resources.entries as entry (entry)}<RetainedViewer
			{entry}
			{paused}
		/>{/each}{/if}
