import { isBuyerCode } from './token';

export function buyerPath(token: string) {
	if (!isBuyerCode(token)) throw new Error('Invalid buyer code.');
	return `/${token}`;
}

export function buyerDestination(pathname: string): { token: string } | null {
	try {
		// Match SvelteKit's decoding while preserving escaped percent signs and separators.
		pathname = pathname.split('%25').map(decodeURI).join('%25');
	} catch {
		return null;
	}
	const match = /^\/([^/]+)\/?$/u.exec(pathname);
	return match && isBuyerCode(match[1]) ? { token: match[1] } : null;
}

export const isBuyerPath = (pathname: string) => buyerDestination(pathname) !== null;
