import { getContext, setContext } from 'svelte';

const helpContext = Symbol('workspace-help');
export type WorkspaceHelp = { open: () => void; hold: () => () => void };

export function setWorkspaceHelp(help: WorkspaceHelp) {
	return setContext(helpContext, help);
}

export function getWorkspaceHelp(): WorkspaceHelp | undefined {
	return getContext(helpContext);
}
