import { createHash } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { ACTIVITY_RETENTION, validTrackingId, type ActivityBrowser } from '$lib/buyer/tracking';

const COOKIE = 'dinu_activity_browsers_v1';
type Entry = NonNullable<ActivityBrowser> & { scope: string };
const scopeFor = (token: string) => createHash('sha256').update(token).digest('hex').slice(0, 24);
function entries(cookies: Cookies): Entry[] {
	try {
		const value: unknown = JSON.parse(cookies.get(COOKIE) ?? '[]');
		if (!Array.isArray(value) || value.length > 8) return [];
		return value.filter(
			(entry): entry is Entry =>
				entry &&
				typeof entry === 'object' &&
				typeof entry.scope === 'string' &&
				/^[a-f0-9]{24}$/u.test(entry.scope) &&
				Number.isFinite(entry.expiresAt) &&
				entry.expiresAt > Date.now() &&
				entry.expiresAt <= Date.now() + ACTIVITY_RETENTION &&
				typeof entry.browserId === 'string' &&
				validTrackingId(entry.browserId)
		);
	} catch {
		return [];
	}
}
export function activityBrowser(cookies: Cookies, token: string): ActivityBrowser {
	const entry = entries(cookies).find((entry) => entry.scope === scopeFor(token));
	if (!entry) return null;
	return { browserId: entry.browserId, expiresAt: entry.expiresAt };
}
export function saveActivityBrowser(
	cookies: Cookies,
	token: string,
	browser: NonNullable<ActivityBrowser>,
	secure: boolean
) {
	const scope = scopeFor(token);
	const previous = entries(cookies).find((entry) => entry.scope === scope);
	if (browser && previous?.browserId === browser.browserId)
		browser = { ...browser, expiresAt: Math.min(browser.expiresAt, previous.expiresAt) };
	const remaining = entries(cookies).filter((entry) => entry.scope !== scope);
	remaining.push({ ...browser, scope });
	const bounded = remaining.slice(-8);
	cookies.set(COOKIE, JSON.stringify(bounded), {
		path: '/',
		httpOnly: true,
		secure,
		sameSite: 'lax',
		maxAge: Math.max(
			1,
			Math.ceil((Math.max(...bounded.map((entry) => entry.expiresAt)) - Date.now()) / 1000)
		)
	});
}
