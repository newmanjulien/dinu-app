import { env } from '$env/dynamic/public';
import { api } from '../../../../../convex/_generated/api';
import { readRouteData } from '$lib/server/route-title';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, request }) => {
	try {
		if (!env.PUBLIC_CONVEX_URL) throw new Error('Convex is unavailable.');
		const credential = await locals.auth?.().getToken({ template: 'convex' });
		if (!credential) throw new Error('Account token is unavailable.');
		const current = await readRouteData(
			env.PUBLIC_CONVEX_URL,
			request.signal,
			(client) => client.query(api.contracts.routeTitle, { id: params.id }),
			credential
		);
		if (current.kind === 'unavailable')
			return {
				resolvedRouteTitle: { kind: 'unavailable' as const, title: 'Contract not found' }
			};
		return {
			resolvedRouteTitle: {
				kind: 'current' as const,
				title: current.buyerName ? `Negotiate with ${current.buyerName}` : 'Negotiate a contract'
			}
		};
	} catch {
		return {
			resolvedRouteTitle: { kind: 'error' as const, title: 'Couldn’t load contract' }
		};
	}
};
