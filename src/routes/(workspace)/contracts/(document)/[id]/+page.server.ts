import { env } from '$env/dynamic/public';
import { api } from '../../../../../convex/_generated/api';
import { readRouteData } from '$lib/server/route-title';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, request, isDataRequest }) => {
	if (isDataRequest)
		return {
			routeBootstrap: null,
			resolvedRouteTitle: { kind: 'pending' as const, title: 'Negotiate a contract' }
		};
	try {
		if (!env.PUBLIC_CONVEX_URL) throw new Error('Convex is unavailable.');
		const auth = locals.auth?.();
		const credential = await auth?.getToken({ template: 'convex' });
		if (!credential) throw new Error('Account token is unavailable.');
		const current = await readRouteData(
			env.PUBLIC_CONVEX_URL,
			request.signal,
			(client) => client.query(api.contracts.routeBootstrap, { id: params.id }),
			credential
		);
		if (current.kind === 'unavailable')
			return {
				resolvedRouteTitle: { kind: 'unavailable' as const, title: 'Contract not found' }
			};
		return {
			routeBootstrap:
				auth && 'sessionId' in auth && 'userId' in auth
					? { ...current, sessionId: auth.sessionId, userId: auth.userId }
					: null,
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
