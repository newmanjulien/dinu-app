import { env } from '$env/dynamic/public';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../../convex/_generated/api';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = async ({ locals, url, cookies }) => {
	const state = url.searchParams.get('state'),
		code = url.searchParams.get('code');
	const purpose =
		state && state === cookies.get('hubspot_quotes_install')
			? 'quotes'
			: state && state === cookies.get('hubspot_install')
				? 'base'
				: null;
	// Leave the cookie to expire: an older response must never delete a newer attempt.
	let installed = false;
	const token = await locals.auth?.().getToken({ template: 'convex' });
	if (
		purpose &&
		state &&
		code &&
		token &&
		env.PUBLIC_CONVEX_URL &&
		!url.searchParams.has('error')
	) {
		try {
			const client = new ConvexHttpClient(env.PUBLIC_CONVEX_URL);
			client.setAuth(token);
			const completed = await client.action(
				api.hubspotOAuth.finish,
				purpose === 'quotes' ? { state, code, purpose } : { state, code }
			);
			installed = purpose === 'quotes' ? completed : true;
		} catch {
			/* Never reflect provider codes or token-bearing exceptions. */
		}
	}
	return new Response(null, {
		status: 303,
		headers: {
			location: `/integrations/${purpose === 'quotes' ? 'hubspot-quote' : 'hubspot'}?installation=${installed ? 'connected' : 'failed'}`,
			'cache-control': 'no-store',
			'referrer-policy': 'no-referrer'
		}
	});
};
