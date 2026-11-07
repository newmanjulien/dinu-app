import { browser } from '$app/environment';
import { hintVisitLimit, type HintId } from './hints';

/** Call once per eligible hint and membership during a page visit. */
export function recordHintVisit(id: HintId, membershipId: string): boolean {
	if (!browser) return false;
	const limit = hintVisitLimit(id);
	if (limit === undefined) return true;
	try {
		const key = `dinu:hint-visits:${membershipId}:${id}`;
		const value = Number(localStorage.getItem(key));
		const visits = Number.isSafeInteger(value) && value >= 0 ? value : 0;
		localStorage.setItem(key, String(Math.min(visits + 1, limit)));
		return visits < limit;
	} catch {
		// Hide visit-limited hints when their dismissal cannot be remembered.
		return false;
	}
}
