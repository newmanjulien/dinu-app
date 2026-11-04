export interface RouteDescription {
	title: string;
	navigation?: '/' | '/admin';
	document?: 'admin' | 'new' | 'saved';
	baseline?: boolean;
	availableDuringHold?: boolean;
	description?: string;
}

const routes: Record<string, RouteDescription> = {
	'/(workspace)': {
		title: 'Find or start a contract',
		navigation: '/',
		description: 'Find, save, and negotiate your contracts.'
	},
	'/(workspace)/admin': {
		title: 'Edit contract instructions',
		navigation: '/admin',
		document: 'admin',
		baseline: true
	},
	'/(workspace)/contracts/new': {
		title: 'Create a contract',
		navigation: '/',
		document: 'new',
		baseline: true
	},
	'/(workspace)/contracts/[id]': {
		title: 'Review and negotiate a contract',
		navigation: '/',
		document: 'saved'
	},
	'/(workspace)/settings': { title: 'Manage your settings', availableDuringHold: true },
	'/(workspace)/team': { title: 'Manage your team' },
	'/(entry)/login': { title: 'Sign in' },
	'/(entry)/join': { title: 'Create your account' },
	'/(entry)/invitation': { title: 'Join your team' },
	'/(onboarding)/onboarding': { title: 'Set up your workspace' }
};
const fallback: RouteDescription = { title: 'Welcome' };

export function describeRoute(id: string | null): RouteDescription {
	return (id && routes[id]) || fallback;
}

/** URL-only callers use the same route policies as mounted SvelteKit routes. */
export function describeDestination(pathname: string): RouteDescription {
	const path = pathname.replace(/\/$/, '') || '/';
	const suffix = path === '/' ? '' : path;
	return (
		routes[`/(workspace)${suffix}`] ??
		routes[`/(entry)${suffix}`] ??
		routes[`/(onboarding)${suffix}`] ??
		(/^\/contracts\/[^/]+$/.test(path) ? routes['/(workspace)/contracts/[id]'] : fallback)
	);
}
