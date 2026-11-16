/** Applicability, display readiness and execution are independent facts. */
export type ToolState = {
	applicability: 'pending' | 'absent' | 'present';
	display: 'pending' | 'ready' | 'failed';
	enabled?: boolean;
	retry?: () => void;
};
export type ToolStates = Record<'search' | 'download' | 'settings' | 'help', ToolState>;
export function orderedTools(states: ToolStates) {
	const visible = new Set<keyof ToolStates>();
	for (const name of ['search', 'download', 'settings', 'help'] as const) {
		const state = states[name];
		if (state.applicability === 'pending') {
			break;
		}
		if (state.applicability === 'absent') continue;
		if (state.display === 'pending') {
			break;
		}
		visible.add(name);
	}
	return visible;
}
let searchCode: Promise<typeof import('./DocumentSearchTools.svelte')> | undefined;
export const loadDocumentSearch = () =>
	(searchCode ??= import('./DocumentSearchTools.svelte').catch((error) => {
		searchCode = undefined;
		throw error;
	}));
export type SearchToolControls = {
	owner: symbol | undefined;
	readonly searchOpen: boolean;
	searchEnabled: boolean;
	onSearchToggle: (trigger: HTMLButtonElement) => void;
	closePanel: (restoreFocus?: boolean) => void;
	setRails: (desktop: HTMLElement | undefined, mobile: HTMLElement | undefined) => void;
};
/** Document-owned behavior offered to a page-owned rail. */
export type DocumentToolControls = SearchToolControls & {
	helpEnabled: boolean;
	onOpenHelp: () => void;
	states: ToolStates;
};
