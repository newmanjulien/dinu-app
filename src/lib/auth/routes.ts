import { buyerDestination } from '$lib/buyer/urls';
export interface RouteDescription {
	title: string;
	presentation:
		| 'contracts'
		| 'settings'
		| 'contract-settings'
		| 'team'
		| 'document'
		| 'integrations'
		| 'integration'
		| 'guides'
		| 'entry'
		| 'onboarding'
		| 'buyer-document'
		| 'neutral';
	navigation?: '/contracts' | '/template' | '/integrations' | '/guides';
	document?: 'template' | 'new' | 'saved';
	requiresTemplate?: boolean;
	availableDuringHold?: boolean;
	description?: string;
}

const routes: Record<string, RouteDescription> = {
	'/contracts': {
		title: 'Manage your contracts',
		presentation: 'contracts',
		navigation: '/contracts',
		description: 'Find, save, and negotiate your contracts.'
	},
	'/template': {
		title: 'Edit template instructions',
		presentation: 'document',
		navigation: '/template',
		document: 'template',
		requiresTemplate: true
	},
	'/template/buyers': {
		title: 'Edit buyer template instructions',
		presentation: 'document',
		navigation: '/template',
		document: 'template',
		requiresTemplate: true
	},
	'/contracts/new': {
		title: 'Create a contract',
		presentation: 'document',
		navigation: '/contracts',
		document: 'new',
		requiresTemplate: true
	},
	'/contracts/[id]': {
		title: 'Negotiate a contract',
		presentation: 'document',
		navigation: '/contracts',
		document: 'saved'
	},
	'/contracts/[id]/settings': {
		title: 'Manage contract settings',
		presentation: 'contract-settings',
		navigation: '/contracts'
	},
	'/settings': {
		title: 'Manage your settings',
		presentation: 'settings',
		availableDuringHold: true
	},
	'/integrations': {
		title: 'Manage integrations',
		presentation: 'integrations',
		navigation: '/integrations',
		description: 'Explore integrations for your contracts.'
	},
	'/integrations/[slug]': {
		title: 'Manage your integration',
		presentation: 'integration',
		navigation: '/integrations',
		description: 'Explore integrations for your contracts.'
	},
	'/guides': {
		title: 'Explore your guides',
		presentation: 'guides',
		navigation: '/guides'
	},
	'/team': { title: 'Manage your team', presentation: 'team' },
	'/[token]': { title: 'Review your contract', presentation: 'buyer-document' },
	'/[token]/contract': { title: 'Review your contract', presentation: 'buyer-document' },
	'/buyer/[token]/details': { title: 'Review your contract', presentation: 'buyer-document' },
	'/buyer/[token]/contract': { title: 'Review your contract', presentation: 'buyer-document' },
	'/login': { title: 'Sign in', presentation: 'entry' },
	'/join': { title: 'Create your account', presentation: 'entry' },
	'/invitation': { title: 'Join your team', presentation: 'onboarding' },
	'/onboarding': { title: 'Set up your workspace', presentation: 'onboarding' }
};
const fallback: RouteDescription = { title: 'Welcome', presentation: 'neutral' };

/** Route groups control layouts; the catalog describes URL patterns. */
export function describeRoute(id: string | null): RouteDescription {
	const path = id?.replace(/\/\([^)]+\)/g, '').replace(/\[([^=\]]+)=[^\]]+\]/g, '[$1]') || '/';
	return id !== null && Object.hasOwn(routes, path) ? routes[path] : fallback;
}

/** URL-only callers use the same route policies as mounted SvelteKit routes. */
export function describeDestination(pathname: string): RouteDescription {
	const path = pathname.replace(/\/$/, '') || '/contracts';
	const buyer = buyerDestination(path);
	if (buyer) return routes['/[token]'];
	return (
		routes[path] ??
		(/^\/contracts\/[^/]+\/settings$/.test(path)
			? routes['/contracts/[id]/settings']
			: /^\/contracts\/[^/]+$/.test(path)
				? routes['/contracts/[id]']
				: /^\/integrations\/[^/]+$/.test(path)
					? routes['/integrations/[slug]']
					: fallback)
	);
}
