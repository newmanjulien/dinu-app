<script lang="ts">
	import { PAGE_FORMAT } from '$lib/document/pagination/page-format';
	import DocumentWorkspaceLayout from './DocumentWorkspaceLayout.svelte';
	import DocumentWorkspaceGeometry from './DocumentWorkspaceGeometry.svelte';
	let {
		reserveReviewGutter = false,
		template = false,
		label = 'Loading document',
		announce = true
	}: {
		reserveReviewGutter?: boolean;
		template?: boolean;
		label?: string;
		announce?: boolean;
	} = $props();
</script>

{#if announce}<span role="status" class="sr-only">{label}</span>{/if}
<div style:--document-section-bottom-padding={template ? '48px' : undefined} aria-hidden="true">
	<DocumentWorkspaceGeometry {reserveReviewGutter}>
		<DocumentWorkspaceLayout
			hasPanel={false}
			loading
			interactive={false}
			documentHeight={PAGE_FORMAT.height}
		>
			{#snippet documentContent()}{/snippet}
			{#snippet panelContent()}{/snippet}
		</DocumentWorkspaceLayout>
	</DocumentWorkspaceGeometry>
</div>
