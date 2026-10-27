export function localReturn(value: string | null | undefined): string {
	if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value))
		return '/';
	const url = new URL(value, 'https://dinu.invalid');
	if (url.origin !== 'https://dinu.invalid' || ['/login', '/join'].includes(url.pathname))
		return '/';
	return url.pathname + url.search + url.hash;
}

export const currentDestination = (url: URL) => localReturn(url.pathname + url.search + url.hash);
export const loginHref = (destination: string) =>
	destination === '/'
		? '/login'
		: `/login?returnTo=${encodeURIComponent(localReturn(destination))}`;
export const onboardingHref = (destination: string) =>
	destination === '/'
		? '/onboarding'
		: `/onboarding?returnTo=${encodeURIComponent(localReturn(destination))}`;

/** Account switching keeps entry flows intact; ordinary workspace logout returns home. */
export function loginDestination(url: URL, recover: boolean): string {
	if (url.pathname === '/invitation') return currentDestination(url);
	const entry = url.pathname === '/onboarding';
	return loginHref(recover || entry ? currentDestination(url) : '/');
}

export function workspaceDestination(value: string | null | undefined): string {
	const destination = localReturn(value);
	return ['/onboarding', '/invitation'].includes(
		new URL(destination, 'https://dinu.invalid').pathname
	)
		? '/'
		: destination;
}
