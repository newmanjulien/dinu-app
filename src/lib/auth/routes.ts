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
		title: 'Home | Dinu',
		navigation: '/',
		description: 'Find, save, and negotiate your contracts.'
	},
	'/(workspace)/admin': {
		title: 'Edit contract instructions | Dinu',
		navigation: '/admin',
		document: 'admin',
		baseline: true
	},
	'/(workspace)/contracts/new': {
		title: 'New contract | Dinu',
		navigation: '/',
		document: 'new',
		baseline: true
	},
	'/(workspace)/contracts/[id]': {
		title: 'Contract | Dinu',
		navigation: '/',
		document: 'saved'
	},
	'/(workspace)/settings': { title: 'Settings | Dinu', availableDuringHold: true },
	'/(workspace)/team': { title: 'Company team | Dinu' },
	'/(entry)/login': { title: 'Log in | Dinu' },
	'/(entry)/join': { title: 'Join | Dinu' },
	'/(entry)/invitation': { title: 'Company invitation | Dinu' },
	'/(onboarding)/onboarding': { title: 'Set up your company | Dinu' }
};
const fallback: RouteDescription = { title: 'Dinu' };

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
