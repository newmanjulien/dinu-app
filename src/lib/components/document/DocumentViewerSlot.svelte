<script lang="ts">
	import type {
		DocumentResource,
		DocumentAttachment,
		ViewerBindings
	} from '$lib/document/runtime/resources.svelte';
	import DocumentViewer from './DocumentViewer.svelte';
	let {
		entry,
		attachment,
		...bindings
	}: ViewerBindings & { entry?: DocumentResource; attachment?: DocumentAttachment } = $props();
	let target = $state<HTMLDivElement>();
	$effect(() => {
		if (entry && attachment) return attachment.bind(bindings, target);
	});
</script>

{#if entry}
	<div bind:this={target}></div>
{:else}
	<DocumentViewer {...bindings} />
{/if}
