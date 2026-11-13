import { untrack } from 'svelte';
import { countStartupWork } from './render-perf';
import { DocumentRenderController } from './renderer.svelte';
import { DocumentSourceController, type DocumentSourceInput } from './source.svelte';
import { DocumentViewerState } from './viewer.svelte';
import type { DocumentWorkspace } from './workspace-context';

function querySnapshot(input: DocumentSourceInput): DocumentSourceInput {
	const materialized = input.materialized?.data;
	const common = input.contract
		? {
				contract: true as const,
				materialized: {
					data: materialized
						? { document: materialized.document, baseline: materialized.baseline }
						: undefined,
					error: input.materialized.error
				}
			}
		: { blocks: { data: input.blocks.data, error: input.blocks.error } };
	switch (input.kind) {
		case 'records':
			return {
				kind: input.kind,
				...common,
				items: { data: input.items.data, error: input.items.error }
			};
		case 'structure':
			return {
				kind: input.kind,
				...common,
				structure: { data: input.structure.data, error: input.structure.error },
				details: input.details,
				pendingRenderKey: input.pendingRenderKey
			};
		case 'overlays':
			return { kind: input.kind, ...common, overlays: input.overlays };
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
				prior.blocks?.data !== current.blocks?.data ||
				prior.blocks?.error !== current.blocks?.error ||
				prior.materialized?.data?.document !== current.materialized?.data?.document ||
				prior.materialized?.data?.baseline !== current.materialized?.data?.baseline ||
				prior.materialized?.error !== current.materialized?.error ||
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
