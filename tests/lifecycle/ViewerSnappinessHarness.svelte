<script lang="ts">
	import SnappinessContext from './SnappinessContext.svelte';
	import DocumentViewerSlot from '../../src/lib/components/document/DocumentViewerSlot.svelte';
	import type { DocumentResources } from '../../src/lib/document/runtime/resources.svelte';
	import type { ContractWorkspace } from '../../src/lib/document/runtime/workspace-context';
	import type { CsmState } from './csm-state.svelte';
	let {
		state,
		resources,
		workspace,
		controls
	}: {
		state: CsmState;
		resources: DocumentResources;
		workspace: ContractWorkspace;
		controls: { active: boolean; report?: (ids: readonly string[]) => void };
	} = $props();
</script>

<SnappinessContext {state} {resources} {workspace}>
	<DocumentViewerSlot
		active={controls.active}
		instructionPreload={controls.report}
		selectedConcessions={{}}
		onRemoveConcession={() => {}}
		onSelect={() => {}}
		allowPlaybookNavigation={true}
		sourceSelectionEnabled={false}
	>
		{#snippet panelContent()}{/snippet}
	</DocumentViewerSlot>
</SnappinessContext>
