import { env } from '$env/dynamic/public';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../../convex/_generated/api';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = async ({ locals, url, cookies }) => {
	const expected = cookies.get('hubspot_install');
	cookies.delete('hubspot_install', { path: '/api/hubspot/callback' });
	let installed = false;
	const state = url.searchParams.get('state'),
		code = url.searchParams.get('code');
	const token = await locals.auth?.().getToken({ template: 'convex' });
	if (
		expected &&
		state === expected &&
		code &&
		token &&
		env.PUBLIC_CONVEX_URL &&
		!url.searchParams.has('error')
	) {
		try {
			const client = new ConvexHttpClient(env.PUBLIC_CONVEX_URL);
			client.setAuth(token);
			await client.action(api.hubspotOAuth.finish, { state, code });
			installed = true;
		} catch {
			/* Never reflect provider codes or token-bearing exceptions. */
		}
	}
	return new Response(null, {
		status: 303,
		headers: {
			location: `/integrations/hubspot?installation=${installed ? 'connected' : 'failed'}`,
			'cache-control': 'no-store',
			'referrer-policy': 'no-referrer'
		}
	});
};
