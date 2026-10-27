<script lang="ts">
	import DocumentPaperSkeleton from './DocumentPaperSkeleton.svelte';
	import DocumentPanelSkeleton from './DocumentPanelSkeleton.svelte';
	import DocumentPageFrame from './DocumentPageFrame.svelte';
	import DocumentWorkspaceGeometry from './DocumentWorkspaceGeometry.svelte';
	let {
		admin = false,
		embedded = false,
		reviewGutter = 0,
		hasPanel = false,
		label = 'Loading contract',
		announce = true
	}: {
		admin?: boolean;
		embedded?: boolean;
		reviewGutter?: number;
		hasPanel?: boolean;
		label?: string;
		announce?: boolean;
	} = $props();
</script>

{#if announce}<span role="status" class="sr-only">{label}</span>{/if}
<div class="document-skeleton" class:embedded class:admin aria-hidden="true">
	{#if admin && !embedded}
		<div class="mb-5 px-2 text-center text-[13px] leading-6 text-ink-muted">
			Edit the instructions reps will see
		</div>
	{/if}
	<DocumentWorkspaceGeometry {reviewGutter} {hasPanel}>
		<DocumentPageFrame>
			<DocumentPaperSkeleton {label} announce={false} />
		</DocumentPageFrame>
		{#if hasPanel}<DocumentPanelSkeleton />{/if}
	</DocumentWorkspaceGeometry>
</div>

<style>
	.document-skeleton {
		padding-block: 56px 64px;
	}
	.document-skeleton.admin {
		padding-bottom: 48px;
	}
	.document-skeleton.embedded {
		padding: 0;
	}
	@media (min-width: 1000px) {
		.document-skeleton:not(.embedded) {
			padding-top: 24px;
		}
	}
</style>
