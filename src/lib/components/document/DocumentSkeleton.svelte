<script lang="ts">
	import DocumentPaperSkeleton from './DocumentPaperSkeleton.svelte';
	import DocumentPanelSkeleton from './DocumentPanelSkeleton.svelte';
	import DocumentPageFrame from './DocumentPageFrame.svelte';
	import DocumentWorkspaceGeometry from './DocumentWorkspaceGeometry.svelte';
	import type { DocumentLayout } from './workspace-layout';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	let {
		layout = 'standard',
		template = false,
		embedded = false,
		reviewGutter = 0,
		hasPanel = false,
		label = 'Loading document',
		announce = true
	}: {
		layout?: DocumentLayout;
		template?: boolean;
		embedded?: boolean;
		reviewGutter?: number;
		hasPanel?: boolean;
		label?: string;
		announce?: boolean;
	} = $props();
</script>

{#if announce}<span role="status" class="sr-only">{label}</span>{/if}
<div
	class={embedded
		? 'p-0'
		: template
			? 'pt-2 pb-12 min-[1000px]:pt-5'
			: 'pt-14 pb-16 min-[1000px]:pt-6'}
	aria-hidden="true"
>
	{#if template && !embedded}
		<div
			class="mb-2 grid min-h-(--mobile-utility-rail-height) place-items-center px-2 min-[1000px]:mb-4 min-[1000px]:min-h-6"
		>
			<SkeletonBlock class="h-3 w-44" />
		</div>
	{/if}
	<DocumentWorkspaceGeometry {layout} {reviewGutter} {hasPanel}>
		<DocumentPageFrame>
			<DocumentPaperSkeleton {label} announce={false} />
		</DocumentPageFrame>
		{#if hasPanel}<DocumentPanelSkeleton />{/if}
	</DocumentWorkspaceGeometry>
</div>
