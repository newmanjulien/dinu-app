import { env as privateEnv } from '$env/dynamic/private';
import { env } from '$env/dynamic/public';
import { readActivity } from '$lib/buyer/activity-transport';
import { saveActivityBrowser } from '$lib/server/activity-browser';
import type { RequestHandler } from './$types';

function deviceCategory(headers: Headers) {
	const agent = headers.get('user-agent') ?? '';
	if (/bot|crawler|spider/iu.test(agent)) return undefined;
	if (/ipad|tablet|playbook|silk/iu.test(agent)) return 'tablet';
	if (/mobi|iphone|ipod/iu.test(agent) || headers.get('sec-ch-ua-mobile') === '?1') return 'phone';
	if (/android/iu.test(agent)) return 'tablet';
	if (/windows|macintosh|x11|cros|linux/iu.test(agent)) return 'computer';
	return undefined;
}
export const POST: RequestHandler = async ({ request, url, cookies, fetch }) => {
	const headers = { 'Cache-Control': 'private, no-store' };
	if (request.headers.get('origin') !== url.origin)
		return new Response(null, { status: 403, headers });
	const body = await readActivity(request);
	if (!body) return new Response(null, { status: 400, headers });
	if (!privateEnv.BUYER_LINK_INGEST_SECRET || !env.PUBLIC_CONVEX_SITE_URL)
		return new Response(null, { status: 503, headers });
	try {
		const device = deviceCategory(request.headers);
		const response = await fetch(`${env.PUBLIC_CONVEX_SITE_URL}/buyer/activity`, {
			method: 'POST',
			signal: AbortSignal.timeout(6000),
			headers: {
				'Content-Type': 'application/json',
				'X-Buyer-Ingest-Secret': privateEnv.BUYER_LINK_INGEST_SECRET,
				...(device ? { 'X-Buyer-Device': device } : {})
			},
			body: JSON.stringify(body)
		});
		if (response.ok && body.kind === 'open') {
			const result: { expiresAt: number } = await response.json();
			if (!Number.isFinite(result.expiresAt)) return new Response(null, { status: 503, headers });
			saveActivityBrowser(
				cookies,
				body.token,
				{ browserId: body.browserId, expiresAt: result.expiresAt },
				url.protocol === 'https:'
			);
			return Response.json(result, { headers });
		}
		return new Response(null, {
			status: response.status,
			headers: {
				...headers,
				...(response.status === 429
					? { 'Retry-After': response.headers.get('retry-after') ?? '5' }
					: {})
			}
		});
	} catch {
		return new Response(null, { status: 503, headers });
	}
};
