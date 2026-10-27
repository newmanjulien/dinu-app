import { preloadCode } from '$app/navigation';
import { loadHome } from '$lib/components/workspace/home';
import { describeDestination } from './routes';

/** Download route code and lazy components together without mounting them or starting queries. */
export async function preloadDestination(pathname: string) {
	pathname = pathname.replace(/\/$/, '') || '/';
	const route = describeDestination(pathname);
	await Promise.all([
		preloadCode(pathname),
		import('./AuthenticatedAccount.svelte'),
		pathname === '/invitation'
			? import('./InvitationLink.svelte')
			: pathname !== '/onboarding'
				? import('./Workspace.svelte')
				: undefined,
		pathname === '/' ? loadHome() : undefined,
		// Workspace waits for a ready baseline before loading its editor and renderer.
		route.document && !route.baseline ? import('./DocumentHost.svelte') : undefined
	]);
}
