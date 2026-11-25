import type { Permission } from '../../convex/permissions';
import { buyerDestination } from '$lib/buyer/urls';
import { CREATE_ACCOUNT_PATH, INVITATION_PATH, LOGIN_PATH, ONBOARDING_PATH } from './navigation';
export interface RouteDescription {
	title: string;
	presentation:
		| 'contracts'
		| 'settings'
		| 'contract-settings'
		| 'team'
		| 'template-setup'
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
	permission?: Permission;
	template?: 'required' | 'pending-only';
	requiresInstructions?: boolean;
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
	'/template/setup': {
		title: 'Set up your template',
		presentation: 'template-setup',
		navigation: '/template',
		permission: 'manageTemplate',
		template: 'pending-only'
	},
	'/template': {
		title: 'Edit template instructions',
		presentation: 'document',
		navigation: '/template',
		document: 'template',
		permission: 'manageTemplate',
		template: 'required'
	},
	'/template/buyers': {
		title: 'Edit buyer template explanations',
		presentation: 'document',
		navigation: '/template',
		document: 'template',
		permission: 'manageTemplate',
		template: 'required'
	},
	'/contracts/new': {
		title: 'Create a contract',
		presentation: 'document',
		navigation: '/contracts',
		document: 'new',
		template: 'required',
		requiresInstructions: true
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
		permission: 'manageIntegrations',
		description: 'Explore integrations for your contracts.'
	},
	'/integrations/[slug]': {
		title: 'Manage your integration',
		presentation: 'integration',
		navigation: '/integrations',
		permission: 'manageIntegrations',
		description: 'Explore integrations for your contracts.'
	},
	'/guides': {
		title: 'Explore your guides',
		presentation: 'guides',
		navigation: '/guides'
	},
	'/team': { title: 'Manage your team', presentation: 'team' },
	'/[token]': { title: 'Review your contract', presentation: 'buyer-document' },
	[LOGIN_PATH]: { title: 'Log in', presentation: 'entry' },
	[CREATE_ACCOUNT_PATH]: { title: 'Create account', presentation: 'entry' },
	[INVITATION_PATH]: { title: 'Join your team', presentation: 'onboarding' },
	[ONBOARDING_PATH]: { title: 'Set up your workspace', presentation: 'onboarding' }
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
