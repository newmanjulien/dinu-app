<script lang="ts">
	import type {
		DocumentResource,
		DocumentAttachment,
		ViewerBindings
	} from '$lib/document/runtime/resources.svelte';
	import { getDocumentSection } from '$lib/document/runtime/section.svelte';
	import DocumentViewer from './DocumentViewer.svelte';
	let {
		entry,
		attachment,
		...bindings
	}: ViewerBindings & { entry?: DocumentResource; attachment?: DocumentAttachment } = $props();
	const section = getDocumentSection();
	if (!section) throw new Error('DocumentViewerSlot requires a DocumentSection.');
	let target = $state<HTMLDivElement>();
	$effect(() => {
		if (entry && attachment) return attachment.bind(bindings, target, section);
	});
</script>

{#if entry}
	<div bind:this={target}></div>
{:else}
	<DocumentViewer {...bindings} {section} />
{/if}
