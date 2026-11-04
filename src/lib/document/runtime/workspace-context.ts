import { getContext, setContext } from 'svelte';
import type { ContractRenderController } from './renderer.svelte';
import type { ContractSourceController, ContractSourceInput } from './source.svelte';
import type { ContractViewerState } from './viewer.svelte';

const WORKSPACE = Symbol('contract-workspace');

/** The retained viewer needs only this small context shape, never workspace construction code. */
export interface ContractWorkspace {
	readonly source: ContractSourceController;
	readonly renderer: ContractRenderController;
	readonly viewer: ContractViewerState;
	accept: (input: ContractSourceInput) => void;
}

export function setContractWorkspace(workspace: ContractWorkspace) {
	return setContext(WORKSPACE, workspace);
}

export function getContractWorkspace(): ContractWorkspace {
	const workspace = getContext<ContractWorkspace>(WORKSPACE);
	if (!workspace) throw new Error('Contract workspace context is required.');
	return workspace;
}
