<script lang="ts">
	import type {
		DocumentResource,
		DocumentAttachment,
		ViewerBindings
	} from '$lib/document/runtime/resources.svelte';
	import LoadingPagination from './LoadingPagination.svelte';
	import ContractViewer from './ContractViewer.svelte';
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
	{#if !entry.workspace.viewer.visible && !entry.workspace.renderer.error && !entry.workspace.viewer.preparationBlocked}<LoadingPagination
			embedded
			hasPanel={bindings.hasPanel}
		/>{/if}
{:else}
	<ContractViewer {...bindings} />
{/if}
