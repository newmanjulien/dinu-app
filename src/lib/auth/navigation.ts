export function localReturn(value: string | null | undefined): string {
	if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value))
		return '/contracts';
	const url = new URL(value, 'https://dinu.invalid');
	if (url.origin !== 'https://dinu.invalid' || ['/login', '/join'].includes(url.pathname))
		return '/contracts';
	return (url.pathname === '/' ? '/contracts' : url.pathname) + url.search + url.hash;
}

export const currentDestination = (url: URL) => localReturn(url.pathname + url.search + url.hash);
export const loginHref = (destination: string) =>
	localReturn(destination) === '/contracts'
		? '/login'
		: `/login?returnTo=${encodeURIComponent(localReturn(destination))}`;
export const onboardingHref = (destination: string) =>
	localReturn(destination) === '/contracts'
		? '/onboarding'
		: `/onboarding?returnTo=${encodeURIComponent(localReturn(destination))}`;

/** Account switching keeps entry flows intact; ordinary workspace logout returns to Contracts. */
export function loginDestination(url: URL, recover: boolean): string {
	if (url.pathname === '/invitation') return currentDestination(url);
	const entry = url.pathname === '/onboarding';
	return loginHref(recover || entry ? currentDestination(url) : '/contracts');
}

export function workspaceDestination(value: string | null | undefined): string {
	const destination = localReturn(value);
	return ['/onboarding', '/invitation'].includes(
		new URL(destination, 'https://dinu.invalid').pathname
	)
		? '/contracts'
		: destination;
}
