import { getContext, setContext } from 'svelte';

const key = Symbol('workspace-runtime');
export interface WorkspaceRuntime {
	readonly ready: boolean;
	readonly paused: boolean;
	readonly error: string;
	readonly navigationIntent: number;
	retry: () => void;
}
export function setWorkspaceRuntime(runtime: WorkspaceRuntime) {
	return setContext(key, runtime);
}
export function getWorkspaceRuntime(): WorkspaceRuntime {
	return getContext(key);
}
