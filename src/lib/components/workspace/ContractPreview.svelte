<script lang="ts">
	import { untrack } from 'svelte';
	import { getWorkspaceRuntime } from '$lib/auth/workspace-context.svelte';
	import type { TemplateContent } from '$lib/contract/saved';
	import { createContractWorkspace } from '$lib/document/runtime/workspace-factory';
	import { setContractWorkspace } from '$lib/document/runtime/workspace-context';
	import ContractViewer from '$lib/components/document/ContractViewer.svelte';
	let { snapshot }: { snapshot: TemplateContent } = $props();
	const runtime = getWorkspaceRuntime();
	const workspace = setContractWorkspace(
		untrack(() =>
			createContractWorkspace({
				blocks: { data: snapshot.blocks },
				items: { data: snapshot.items }
			})
		)
	);
	$effect(() =>
		workspace.accept({ blocks: { data: snapshot.blocks }, items: { data: snapshot.items } })
	);
</script>

<ContractViewer
	active={!runtime.paused}
	prepare={!runtime.paused}
	interactive={false}
	selectedConcessions={{}}
	allowPlaybookNavigation={false}
	onRemoveConcession={() => {}}
	onSelect={() => false}
>
	{#snippet panelContent()}{/snippet}
</ContractViewer>
