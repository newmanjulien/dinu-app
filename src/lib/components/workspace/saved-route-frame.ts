import type { DocumentWorkspace } from '$lib/document/runtime/workspace-context';

/** The lazy viewer supplies document controls to the persistent saved route frame. */
export type SavedRouteFrameState = {
	id: string;
	workspace?: DocumentWorkspace;
	interactionOwner?: symbol;
	readonly onDownload?: () => void;
	readonly downloadReason?: string | null;
};
