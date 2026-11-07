const HIDE_HELP_STORAGE_KEY = 'hide-dinu-guide';

export function isHelpHidden(): boolean {
	try {
		return localStorage.getItem(HIDE_HELP_STORAGE_KEY) === 'true';
	} catch {
		return false;
	}
}

export function setHelpHidden(hidden: boolean): void {
	try {
		localStorage.setItem(HIDE_HELP_STORAGE_KEY, String(hidden));
	} catch {
		/* Storage is optional. */
	}
}
