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
<div
	class={embedded
		? 'p-0'
		: admin
			? 'pt-2 pb-12 min-[1000px]:pt-5'
			: 'pt-14 pb-16 min-[1000px]:pt-6'}
	aria-hidden="true"
>
	{#if admin && !embedded}
		<div
			class="mb-2 grid min-h-(--mobile-utility-rail-height) place-items-center min-[1000px]:mb-4 min-[1000px]:block min-[1000px]:min-h-0 px-2 text-center text-[13px] leading-6 text-ink-muted"
		>
			Edit the instructions reps see
		</div>
	{/if}
	<DocumentWorkspaceGeometry {reviewGutter} {hasPanel}>
		<DocumentPageFrame>
			<DocumentPaperSkeleton {label} announce={false} />
		</DocumentPageFrame>
		{#if hasPanel}<DocumentPanelSkeleton />{/if}
	</DocumentWorkspaceGeometry>
</div>
