import { preloadCode } from '$app/navigation';
import { loadContracts } from '$lib/components/workspace/contracts';
import { describeDestination } from './routes';

/** Download route code and lazy components together without mounting them or starting queries. */
export async function preloadDestination(pathname: string) {
	pathname = pathname.replace(/\/$/, '') || '/contracts';
	const route = describeDestination(pathname);
	await Promise.all([
		preloadCode(pathname),
		import('./AuthenticatedAccount.svelte'),
		pathname === '/invitation'
			? import('./InvitationLink.svelte')
			: pathname !== '/onboarding'
				? import('./Workspace.svelte')
				: undefined,
		route.presentation === 'contracts' ? loadContracts() : undefined,
		// Template routes wait for template admission before loading document construction code.
		route.document && !route.requiresTemplate ? import('./DocumentHost.svelte') : undefined,
		route.document && !route.requiresTemplate
			? import('$lib/document/runtime/workspace-factory')
			: undefined
	]);
}
