import { getContext, setContext } from 'svelte';
import type { DocumentRenderController } from './renderer.svelte';
import type { DocumentSourceController, DocumentSourceInput } from './source.svelte';
import type { DocumentViewerState } from './viewer.svelte';

const WORKSPACE = Symbol('document-workspace');

/** The retained viewer needs only this small context shape, never workspace construction code. */
export interface DocumentWorkspace {
	readonly source: DocumentSourceController;
	readonly renderer: DocumentRenderController;
	readonly viewer: DocumentViewerState;
	accept: (input: DocumentSourceInput) => void;
}

export function setDocumentWorkspace(workspace: DocumentWorkspace) {
	return setContext(WORKSPACE, workspace);
}

export function getDocumentWorkspace(): DocumentWorkspace {
	const workspace = getOptionalDocumentWorkspace();
	if (!workspace) throw new Error('Document workspace context is required.');
	return workspace;
}

export function getOptionalDocumentWorkspace(): DocumentWorkspace | undefined {
	return getContext<DocumentWorkspace>(WORKSPACE);
}
