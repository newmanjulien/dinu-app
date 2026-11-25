export const LOGIN_PATH = '/login';
export const CREATE_ACCOUNT_PATH = '/create-account';
export const INVITATION_PATH = '/invitation';
export const ONBOARDING_PATH = '/onboarding';

export const CLERK_AUTH_URLS = {
	signInUrl: LOGIN_PATH,
	signUpUrl: CREATE_ACCOUNT_PATH
} as const;

function normalizedPath(pathname: string): string {
	return pathname.replace(/\/+$/, '') || '/';
}

export function isCreateAccountPath(pathname: string): boolean {
	return normalizedPath(pathname) === CREATE_ACCOUNT_PATH;
}

export function isAccountEntryPath(pathname: string): boolean {
	const path = normalizedPath(pathname);
	return path === LOGIN_PATH || path === CREATE_ACCOUNT_PATH;
}

export function isEntryPath(pathname: string): boolean {
	const path = normalizedPath(pathname);
	return isAccountEntryPath(path) || path === INVITATION_PATH;
}

export function localReturn(value: string | null | undefined): string {
	if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value))
		return '/contracts';
	const url = new URL(value, 'https://dinu.invalid');
	if (url.origin !== 'https://dinu.invalid' || isAccountEntryPath(url.pathname))
		return '/contracts';
	return (url.pathname === '/' ? '/contracts' : url.pathname) + url.search + url.hash;
}

function entryHref(path: string, destination: string): string {
	const target = localReturn(destination);
	return target === '/contracts' ? path : `${path}?returnTo=${encodeURIComponent(target)}`;
}

export const currentDestination = (url: URL) => localReturn(url.pathname + url.search + url.hash);
export const loginHref = (destination: string) => entryHref(LOGIN_PATH, destination);
export const createAccountHref = (destination: string) =>
	entryHref(CREATE_ACCOUNT_PATH, destination);
export const onboardingHref = (destination: string) => entryHref(ONBOARDING_PATH, destination);

export function createAccountDestination(returnTo: string): string {
	const pathname = normalizedPath(new URL(returnTo, 'https://dinu.invalid').pathname);
	return pathname === ONBOARDING_PATH || pathname === INVITATION_PATH
		? returnTo
		: onboardingHref(returnTo);
}

/** Account switching keeps entry flows intact; ordinary workspace logout returns to Contracts. */
export function loginDestination(url: URL, recover: boolean): string {
	const path = normalizedPath(url.pathname);
	if (path === INVITATION_PATH) return currentDestination(url);
	const entry = path === ONBOARDING_PATH;
	return loginHref(recover || entry ? currentDestination(url) : '/contracts');
}

export function workspaceDestination(value: string | null | undefined): string {
	const destination = localReturn(value);
	return [ONBOARDING_PATH, INVITATION_PATH].includes(
		normalizedPath(new URL(destination, 'https://dinu.invalid').pathname)
	)
		? '/contracts'
		: destination;
}
