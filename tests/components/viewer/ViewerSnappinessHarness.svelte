<script lang="ts">
	import SnappinessContext from './SnappinessContext.svelte';
	import RetainedViewer from '../../../src/lib/components/document/RetainedViewer.svelte';
	import type { DocumentResource } from '../../../src/lib/document/runtime/resources.svelte';
	import DocumentViewer from '../../../src/lib/components/document/DocumentViewer.svelte';
	import type { Priority } from '../../../src/lib/document/runtime/scheduler';
	import type { DocumentResources } from '../../../src/lib/document/runtime/resources.svelte';
	import type { DocumentWorkspace } from '../../../src/lib/document/runtime/workspace-context';
	import type { CsmState } from '../../support/csm-state.svelte';
	let {
		state,
		resources,
		workspace,
		controls,
		entry
	}: {
		state: CsmState;
		resources: DocumentResources;
		workspace: DocumentWorkspace;
		entry?: DocumentResource;
		controls: {
			active: boolean;
			prepare?: boolean;
			retained?: boolean;
			priority?: Priority;
			report?: (ids: readonly string[]) => void;
		};
	} = $props();
</script>

<SnappinessContext {state} {resources} {workspace}>
	{#if entry}
		<RetainedViewer {entry} />
	{:else}
		<DocumentViewer
			active={controls.active}
			prepare={controls.prepare ?? true}
			retained={controls.retained ?? false}
			priority={controls.priority}
			itemPreload={controls.report}
			selectedConcessions={{}}
			onRemoveConcession={() => {}}
			onSelect={() => {}}
			allowPlaybookNavigation={true}
			sourceSelectionEnabled={false}
		>
			{#snippet panelContent()}{/snippet}
		</DocumentViewer>
	{/if}
</SnappinessContext>
