/** Document-owned behavior offered to a page-owned rail. */
export type DocumentToolControls = {
	owner: symbol | undefined;
	readonly searchOpen: boolean;
	searchEnabled: boolean;
	helpEnabled: boolean;
	onSearchToggle: (trigger: HTMLButtonElement) => void;
	onOpenHelp: () => void;
	closePanel: (restoreFocus?: boolean) => void;
	setRails: (desktop: HTMLElement | undefined, mobile: HTMLElement | undefined) => void;
};
