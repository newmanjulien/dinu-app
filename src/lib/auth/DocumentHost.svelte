<script lang="ts">
	import { LayoutProfiler } from '$lib/document/pagination/profiler';
	import RetainedViewer from '$lib/components/document/RetainedViewer.svelte';
	import LayoutProfileSurface from '$lib/components/document/LayoutProfileSurface.svelte';
	import type { DocumentLayoutProfiles } from '$lib/document/runtime/layout-context.svelte';
	import type { DocumentResources } from '$lib/document/runtime/resources.svelte';
	let {
		profiles,
		resources,
		paused = false
	}: {
		profiles?: DocumentLayoutProfiles;
		resources?: DocumentResources;
		paused?: boolean;
	} = $props();
	$effect(() => profiles?.install(LayoutProfiler));
</script>

{#if profiles}<LayoutProfileSurface bind:surface={profiles.surface} />{/if}
{#if resources}{#each resources.entries as entry (entry)}<RetainedViewer
			{entry}
			{paused}
		/>{/each}{/if}
