import { getContext, setContext } from 'svelte';

const key = Symbol('workspace-readiness');
class WorkspaceReadiness {
	painted = $state(false);
}
export const setWorkspaceReadiness = () => setContext(key, new WorkspaceReadiness());
export const useWorkspaceReadiness = () => getContext<WorkspaceReadiness>(key);
