import { page } from '$app/state';
import { useViewer } from '$lib/auth/viewer-session.svelte';
type HelpPreference = 'rep' | 'buyer';
export function useHelpPreferenceScope() {
	const viewer = useViewer();
	return () => (viewer ? viewer().membership.id : (page.data.buyerPreferenceScope ?? null));
}
export function isHelpHidden(variant: HelpPreference, scope: string | null): boolean {
	if (!scope) return false;
	try {
		return localStorage.getItem(`dinu:help:${variant}:${scope}`) === 'true';
	} catch {
		return false;
	}
}
export function setHelpHidden(
	hidden: boolean,
	variant: HelpPreference,
	scope: string | null
): void {
	if (!scope) return;
	try {
		localStorage.setItem(`dinu:help:${variant}:${scope}`, String(hidden));
	} catch {
		/* Storage is optional. */
	}
}
