import { preloadCode } from '$app/navigation';
import { loadContracts } from '$lib/components/workspace/contracts';
import { INVITATION_PATH } from './navigation';
import { describeDestination } from './routes';

/** Share intent and demand imports, retrying failed downloads on the next demand. */
function shared<T>(load: () => Promise<T>) {
	let pending: Promise<T> | undefined;
	return () =>
		(pending ??= load().catch((error) => {
			pending = undefined;
			throw error;
		}));
}

export const loadDocumentHost = shared(() => import('./DocumentHost.svelte'));
export const loadDocumentWorkspace = shared(
	() => import('$lib/document/runtime/workspace-factory')
);
export const loadTemplateWorkspace = shared(
	() => import('$lib/components/workspace/TemplateWorkspace.svelte')
);
export const loadContractCreation = shared(
	() => import('$lib/components/workspace/ContractCreation.svelte')
);
export const loadSavedContract = shared(
	() => import('$lib/components/workspace/SavedContract.svelte')
);

/** Caller admits the destination; this downloads code only. */
export function warmDocumentDestination(kind: 'template' | 'saved' | 'new') {
	void Promise.all([
		loadDocumentHost(),
		loadDocumentWorkspace(),
		kind === 'template'
			? loadTemplateWorkspace()
			: kind === 'new'
				? loadContractCreation()
				: loadSavedContract()
	]).catch(() => {});
}

/** Download route code and lazy components together without mounting them or starting queries. */
export async function preloadDestination(pathname: string) {
	pathname = pathname.replace(/\/$/, '') || '/contracts';
	const route = describeDestination(pathname);
	await Promise.all([
		preloadCode(pathname),
		import('./AuthenticatedAccount.svelte'),
		import('./AccountContentScope.svelte'),
		pathname === INVITATION_PATH ? import('./InvitationLink.svelte') : undefined,
		route.presentation === 'contracts' ? loadContracts() : undefined,
		// Leave template-gated routes to admitted intent so direct visits wait for template readiness.
		route.document && route.template !== 'required' ? loadDocumentHost() : undefined,
		route.document && route.template !== 'required' ? loadDocumentWorkspace() : undefined
	]);
}
