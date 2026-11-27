import { getContext, setContext } from 'svelte';
import { api } from '../../convex/_generated/api';
import { useReadQuery } from './read-query.svelte';
import { useViewer, useViewerSession } from './viewer-session.svelte';

/** Setup stays live after the first template visit until the source is released. */
export function createWorkspaceTemplateReads() {
	const viewer = useViewer();
	const session = useViewerSession();
	let opened = $state(false);
	const status = useReadQuery(
		api.templateSetup.status,
		() =>
			opened &&
			session.preparedSessionId &&
			!session.blocked &&
			!session.closing &&
			!viewer().company.deletion &&
			viewer().permissions.manageTemplate &&
			!viewer().templateReady
				? {}
				: 'skip',
		() => session.transportGeneration
	);
	return {
		status,
		open: () => {
			opened = true;
		}
	};
}
export type WorkspaceTemplateReads = ReturnType<typeof createWorkspaceTemplateReads>;
const key = Symbol('workspace-template-reads');
export const setWorkspaceTemplateReads = (reads: WorkspaceTemplateReads) => setContext(key, reads);
export const useWorkspaceTemplateReads = () => getContext<WorkspaceTemplateReads | undefined>(key);
