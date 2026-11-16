import type { DocumentWorkspace } from '$lib/document/runtime/workspace-context';
import type { TemplateAudience } from '$lib/playbook/model';

/** The lazy editor supplies document controls to the persistent template route frame. */
export type TemplateRouteFrameState = {
	audience: TemplateAudience;
	workspace: DocumentWorkspace;
	interactionOwner: symbol;
	available: boolean;
};
