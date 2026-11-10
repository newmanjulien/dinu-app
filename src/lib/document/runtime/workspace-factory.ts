import { untrack } from 'svelte';
import { countStartupWork } from './render-perf';
import { DocumentRenderController } from './renderer.svelte';
import { DocumentSourceController, type DocumentSourceInput } from './source.svelte';
import { DocumentViewerState } from './viewer.svelte';
import type { DocumentWorkspace } from './workspace-context';

function querySnapshot(input: DocumentSourceInput): DocumentSourceInput {
	const contract = input.contract;
	const blocks = { data: input.blocks.data, error: input.blocks.error };
	switch (input.kind) {
		case 'records':
			return {
				kind: input.kind,
				contract,
				blocks,
				items: { data: input.items.data, error: input.items.error }
			};
		case 'structure':
			return {
				kind: input.kind,
				contract,
				blocks,
				structure: { data: input.structure.data, error: input.structure.error },
				details: input.details,
				pendingRenderKey: input.pendingRenderKey
			};
		case 'overlays':
			return { kind: input.kind, contract, blocks, overlays: input.overlays };
	}
}

/** Constructing source, renderer, and viewer state stays behind the document-runtime boundary. */
export function createDocumentWorkspace(
	initial: DocumentSourceInput,
	view: import('$lib/document/model').DocumentView = 'redline'
): DocumentWorkspace {
	countStartupWork('workspaceCreated');
	const source = new DocumentSourceController();
	let accepted: DocumentSourceInput | undefined;

	function accept(input: DocumentSourceInput) {
		// Track live query dependencies, not the state changed during acceptance.
		const current = querySnapshot(input);
		untrack(() => {
			const prior = accepted;
			if (
				!prior ||
				prior.kind !== current.kind ||
				prior.contract !== current.contract ||
				prior.blocks.data !== current.blocks.data ||
				prior.blocks.error !== current.blocks.error ||
				prior.items?.data !== current.items?.data ||
				prior.items?.error !== current.items?.error ||
				prior.structure?.data !== current.structure?.data ||
				prior.structure?.error !== current.structure?.error ||
				prior.details !== current.details ||
				prior.pendingRenderKey !== current.pendingRenderKey ||
				prior.overlays !== current.overlays
			) {
				source.accept(current);
				accepted = current;
			}
		});
	}

	accept(initial);
	return {
		source,
		renderer: new DocumentRenderController(view),
		viewer: new DocumentViewerState(),
		accept
	};
}
