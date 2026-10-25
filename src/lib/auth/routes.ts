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
		title: 'Home | Agreed',
		navigation: '/',
		description: 'Find, save, and negotiate your contracts.'
	},
	'/(workspace)/admin': {
		title: 'Edit contract instructions | Agreed',
		navigation: '/admin',
		document: 'admin',
		baseline: true
	},
	'/(workspace)/contracts/new': {
		title: 'New contract | Agreed',
		navigation: '/',
		document: 'new',
		baseline: true
	},
	'/(workspace)/contracts/[id]': {
		title: 'Contract | Agreed',
		navigation: '/',
		document: 'saved'
	},
	'/(workspace)/settings': { title: 'Settings | Agreed', availableDuringHold: true },
	'/(workspace)/team': { title: 'Company team | Agreed' },
	'/(entry)/login': { title: 'Log in | Agreed' },
	'/(entry)/join': { title: 'Join | Agreed' },
	'/(entry)/invitation': { title: 'Company invitation | Agreed' },
	'/(onboarding)/onboarding': { title: 'Set up your company | Agreed' }
};
const fallback: RouteDescription = { title: 'Agreed' };

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
