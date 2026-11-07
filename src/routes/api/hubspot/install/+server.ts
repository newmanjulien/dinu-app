import { env } from '$env/dynamic/public';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../../convex/_generated/api';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = async ({ locals, request, url, cookies }) => {
	if (request.headers.get('origin') !== url.origin)
		return new Response('Invalid origin.', { status: 403 });
	const token = await locals.auth?.().getToken({ template: 'convex' });
	if (!token) return new Response('Sign in required.', { status: 401 });
	if (!env.PUBLIC_CONVEX_URL)
		return new Response('Missing backend configuration.', { status: 503 });
	const client = new ConvexHttpClient(env.PUBLIC_CONVEX_URL);
	client.setAuth(token);
	try {
		const result = await client.action(api.hubspotOAuth.start, {});
		cookies.set('hubspot_install', result.state, {
			path: '/api/hubspot/callback',
			httpOnly: true,
			secure: url.protocol === 'https:',
			sameSite: 'lax',
			maxAge: 600
		});
		return new Response(null, {
			status: 303,
			headers: { location: result.url, 'cache-control': 'no-store' }
		});
	} catch {
		return new Response(null, {
			status: 303,
			headers: {
				location: '/integrations/hubspot?installation=failed',
				'cache-control': 'no-store'
			}
		});
	}
};
