import { loadHome } from '$lib/components/workspace/home';

/** Download independent modules together without mounting them or starting queries. */
export async function preloadDestination(pathname: string) {
	await Promise.all([
		import('./AuthenticatedAccount.svelte'),
		pathname === '/invitation'
			? import('./InvitationLink.svelte')
			: pathname === '/onboarding'
				? import('./onboarding/OnboardingFlow.svelte')
				: import('./Workspace.svelte'),
		pathname === '/' ? loadHome() : undefined,
		/^\/(admin|contracts)(\/|$)/.test(pathname) ? import('./DocumentHost.svelte') : undefined
	]);
}
