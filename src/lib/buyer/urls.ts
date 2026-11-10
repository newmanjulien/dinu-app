import { isBuyerCode } from './token';

export function buyerPath(token: string) {
	const encoded = encodeURIComponent(token);
	return isBuyerCode(token) ? `/${encoded}` : `/buyer/${encoded}/contract`;
}

export function buyerDestination(pathname: string): { token: string } | null {
	try {
		// Match SvelteKit's decoding while preserving escaped percent signs and separators.
		pathname = pathname.split('%25').map(decodeURI).join('%25');
	} catch {
		return null;
	}
	const numeric = /^\/([0-9]{39})(?:\/contract)?\/?$/u.exec(pathname);
	if (numeric) return { token: numeric[1] };
	const legacy = /^\/buyer\/([^/]+)(?:\/(details|contract))?\/?$/u.exec(pathname);
	return legacy ? { token: legacy[1] } : null;
}

export const isBuyerPath = (pathname: string) =>
	pathname.startsWith('/buyer/') || buyerDestination(pathname) !== null;
