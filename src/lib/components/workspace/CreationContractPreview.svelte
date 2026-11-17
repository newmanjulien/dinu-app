<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { getWorkspaceRuntime } from '$lib/auth/workspace-context.svelte';
	import { getTemplateSource } from '$lib/playbook/template-source.svelte';
	import { createDocumentWorkspace } from '$lib/document/runtime/workspace-factory';
	import { setDocumentWorkspace } from '$lib/document/runtime/workspace-context';
	import type { DocumentSourceInput } from '$lib/document/runtime/source.svelte';
	import DocumentViewer from '$lib/components/document/DocumentViewer.svelte';

	let {
		freeze = false,
		onFailure = () => {}
	}: {
		freeze?: boolean;
		onFailure?: (failed: boolean) => void;
	} = $props();
	const runtime = getWorkspaceRuntime();
	const templateSource = getTemplateSource();
	const releaseSource = untrack(() => templateSource.retain());
	onDestroy(releaseSource);
	let frozenSource = $state.raw<NonNullable<typeof templateSource.read.data>>();
	$effect(() => {
		if (!freeze || frozenSource) return;
		const source = templateSource.read.data;
		if (source) frozenSource = source;
	});
	const input: DocumentSourceInput = $derived({
		kind: 'prose',
		blocks: {
			data: (frozenSource ?? templateSource.read.data)?.blocks,
			error: frozenSource ? undefined : templateSource.read.error
		}
	});
	const workspace = setDocumentWorkspace(untrack(() => createDocumentWorkspace(input)));
	$effect(() => workspace.accept(input));
	const firstPagesReady = $derived(
		Boolean(
			workspace.viewer.firstPagesReady?.pages.length &&
			workspace.viewer.firstPagesReady.source === workspace.source.renderSource
		)
	);
	$effect(() => {
		onFailure(!firstPagesReady && Boolean(workspace.source.issue || workspace.renderer.error));
	});
</script>

{#snippet emptyPanel()}{/snippet}
<main
	class="[--document-section-bottom-padding:calc(64px+var(--buyer-link-bar-height,0px))] [--workspace-loading-inset:calc(var(--spacing)*30)] min-[1000px]:[--workspace-loading-inset:calc(var(--spacing)*22)]"
	class:invisible={!firstPagesReady}
	aria-label="Contract document"
>
	<DocumentViewer
		reserveReviewGutter
		active={!runtime.paused}
		prepare={!runtime.paused}
		interactive={false}
		annotationsVisible={false}
		selectedConcessions={{}}
		allowPlaybookNavigation={false}
		onRemoveConcession={() => {}}
		onSelect={() => false}
		panelContent={emptyPanel}
	/>
</main>
