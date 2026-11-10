<script lang="ts">
	import { isRepItem } from '$lib/playbook/model';
	import { untrack } from 'svelte';
	import { getWorkspaceRuntime } from '$lib/auth/workspace-context.svelte';
	import type { TemplateContent } from '$lib/template/model';
	import { createDocumentWorkspace } from '$lib/document/runtime/workspace-factory';
	import { setDocumentWorkspace } from '$lib/document/runtime/workspace-context';
	import DocumentViewer from '$lib/components/document/DocumentViewer.svelte';
	let { snapshot }: { snapshot: TemplateContent } = $props();
	const runtime = getWorkspaceRuntime();
	const workspace = setDocumentWorkspace(
		untrack(() =>
			createDocumentWorkspace({
				kind: 'records',
				blocks: { data: snapshot.blocks },
				items: { data: snapshot.items.filter(isRepItem) }
			})
		)
	);
	$effect(() =>
		workspace.accept({
			kind: 'records' as const,
			blocks: { data: snapshot.blocks },
			items: { data: snapshot.items.filter(isRepItem) }
		})
	);
</script>

<DocumentViewer
	active={!runtime.paused}
	prepare={!runtime.paused}
	interactive={false}
	selectedConcessions={{}}
	allowPlaybookNavigation={false}
	onRemoveConcession={() => {}}
	onSelect={() => false}
>
	{#snippet panelContent()}{/snippet}
</DocumentViewer>
