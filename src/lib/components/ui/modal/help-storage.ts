/** Only confirmed actual buyers use browser storage, scoped to this buyer link. */
function buyerHelpKey(scope: string) {
	return `dinu:help:anonymous-buyer-link:${scope}`;
}
export function isBuyerHelpHidden(scope: string): boolean {
	try {
		return localStorage.getItem(buyerHelpKey(scope)) === 'true';
	} catch {
		return false;
	}
}
export function setBuyerHelpHidden(scope: string, hidden: boolean): void {
	// Let the session report a failed write instead of presenting it as saved.
	localStorage.setItem(buyerHelpKey(scope), String(hidden));
}
