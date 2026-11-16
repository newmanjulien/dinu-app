import { activityBrowser, scopeFor } from '$lib/server/activity-browser';
import { env } from '$env/dynamic/public';
import { api } from '../../convex/_generated/api';
import { readRouteData } from '$lib/server/route-title';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ cookies, params, locals, request }) => {
	if (cookies.get('dinu_activity_choices_v1'))
		cookies.delete('dinu_activity_choices_v1', { path: '/' });
	const token = params.token;
	let resolvedRouteTitle:
		| { kind: 'current'; title: string; audience: 'buyer' | 'seller'; buyerName: string | null }
		| { kind: 'unavailable' | 'error' | 'account-error'; title: string };
	try {
		if (!token || !env.PUBLIC_CONVEX_URL) throw new Error('Buyer link is unavailable.');
		const credential = await locals.buyerPageCredential?.();
		if (!credential || credential.kind === 'unknown') {
			resolvedRouteTitle = { kind: 'account-error', title: 'Couldn’t check your account' };
		} else {
			const current = await readRouteData(
				env.PUBLIC_CONVEX_URL,
				request.signal,
				(client) => client.query(api.buyerLinks.pageContext, { token }),
				credential.kind === 'account' ? credential.token : undefined
			);
			if (current.kind === 'unavailable') {
				resolvedRouteTitle = { kind: 'unavailable', title: 'Link unavailable' };
			} else if (current.kind === 'account-error') {
				resolvedRouteTitle = { kind: 'account-error', title: 'Couldn’t check your account' };
			} else {
				resolvedRouteTitle = {
					kind: 'current',
					audience: current.audience,
					buyerName: current.buyerName,
					title:
						current.audience === 'buyer'
							? 'Review your contract'
							: current.buyerName
								? `Leave comments for ${current.buyerName}`
								: 'Leave comments'
				};
			}
		}
	} catch {
		resolvedRouteTitle = { kind: 'error', title: 'Couldn’t open contract' };
	}
	return {
		resolvedRouteTitle,
		hasAccountSession: cookies
			.getAll()
			.some(({ name }) => /^(?:__session|__client_uat)(?:_[^=;]+)?$/u.test(name)),
		buyerPreferenceScope: params.token ? scopeFor(params.token) : null,
		activityBrowser: params.token ? activityBrowser(cookies, params.token) : null
	};
};
