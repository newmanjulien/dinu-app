import { untrack } from 'svelte';
import { countStartupWork } from './render-perf';
import { ContractRenderController } from './renderer.svelte';
import { ContractSourceController, type ContractSourceInput } from './source.svelte';
import { ContractViewerState } from './viewer.svelte';
import type { ContractWorkspace } from './workspace-context';

function querySnapshot(input: ContractSourceInput): ContractSourceInput {
	return {
		blocks: { data: input.blocks.data, error: input.blocks.error },
		items: { data: input.items.data, error: input.items.error }
	};
}

/** Constructing source, renderer, and viewer state stays behind the document-runtime boundary. */
export function createContractWorkspace(initial: ContractSourceInput): ContractWorkspace {
	countStartupWork('workspaceCreated');
	const source = new ContractSourceController();
	let accepted: ContractSourceInput | undefined;

	function accept(input: ContractSourceInput) {
		// Track live query dependencies, not the state changed during acceptance.
		const current = querySnapshot(input);
		untrack(() => {
			const prior = accepted;
			if (
				!prior ||
				prior.blocks.data !== current.blocks.data ||
				prior.blocks.error !== current.blocks.error ||
				prior.items.data !== current.items.data ||
				prior.items.error !== current.items.error
			) {
				source.accept(current);
				accepted = current;
			}
		});
	}

	accept(querySnapshot(initial));
	return {
		source,
		renderer: new ContractRenderController(),
		viewer: new ContractViewerState(),
		accept
	};
}
