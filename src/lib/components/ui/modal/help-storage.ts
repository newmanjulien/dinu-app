import type { HelpVariant } from './help-content';

const HIDE_HELP_STORAGE_KEYS: Record<HelpVariant, string> = {
	rep: 'hide-dinu-guide',
	admin: 'hide-dinu-admin-guide'
};

export function isHelpHidden(variant: HelpVariant): boolean {
	try {
		return localStorage.getItem(HIDE_HELP_STORAGE_KEYS[variant]) === 'true';
	} catch {
		return false;
	}
}

export function setHelpHidden(variant: HelpVariant, hidden: boolean): void {
	try {
		localStorage.setItem(HIDE_HELP_STORAGE_KEYS[variant], String(hidden));
	} catch {
		/* Storage is optional. */
	}
}
