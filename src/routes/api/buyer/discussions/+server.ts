import { env as privateEnv } from '$env/dynamic/private';
import { env } from '$env/dynamic/public';
import { readDiscussionRequest } from '$lib/discussions/transport';
import { optionalBuyerToken } from '$lib/server/buyer-token';
import { validTrackingId } from '$lib/buyer/tracking';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = async ({ request, url, cookies, fetch }) => {
	const failure = (message: string, status: number) =>
		Response.json({ message }, { status, headers: { 'Cache-Control': 'private, no-store' } });
	if (request.headers.get('origin') !== url.origin)
		return failure('This request is unavailable.', 403);
	if (!privateEnv.BUYER_LINK_INGEST_SECRET || !env.PUBLIC_CONVEX_SITE_URL)
		return failure('Comments are temporarily unavailable.', 503);
	const body = await readDiscussionRequest(request);
	if (!body) return failure('Invalid message request.', 400);
	const existing = cookies.get('dinu_discussion_browser');
	let browserId = existing && validTrackingId(existing) ? existing : undefined;
	if (!browserId) {
		if (body.kind === 'write')
			return failure('Reopen the discussion and try again. Your draft is still here.', 409);
		const legacy = cookies.get('dinu_buyer_browser');
		browserId = legacy && validTrackingId(legacy) ? legacy : crypto.randomUUID();
		cookies.set('dinu_discussion_browser', browserId, {
			path: '/',
			httpOnly: true,
			secure: url.protocol === 'https:',
			sameSite: 'lax',
			maxAge: 180 * 24 * 60 * 60
		});
	}
	const anonymous = request.headers.get('X-Discussion-Actor') === 'buyer';
	const authorization = request.headers.get('authorization');
	const bearer =
		authorization?.startsWith('Bearer ') && authorization.length <= 16_384
			? authorization.slice(7)
			: null;
	// The Convex ingress verifies explicit account tokens; cookie-only requests retain the local fast path.
	const jwt = anonymous ? null : (bearer ?? (await optionalBuyerToken(request, url.origin, fetch)));
	const hasSession = /(?:^|;\s*)__session(?:_[^=;]+)?=/u.test(request.headers.get('cookie') ?? '');
	if (!anonymous && hasSession && !jwt)
		return failure('Reconnect your account before posting. Your draft is still here.', 401);
	try {
		const response = await fetch(`${env.PUBLIC_CONVEX_SITE_URL}/buyer/discussions`, {
			method: 'POST',
			signal: AbortSignal.timeout(12_000),
			headers: {
				'Content-Type': 'application/json',
				'X-Buyer-Ingest-Secret': privateEnv.BUYER_LINK_INGEST_SECRET,
				...(jwt ? { Authorization: `Bearer ${jwt}` } : {})
			},
			body: JSON.stringify({ ...body, browserId })
		});
		return new Response(await response.text(), {
			status: response.status,
			headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }
		});
	} catch {
		return failure('We couldn’t reach this discussion. Your draft is still here. Try again.', 503);
	}
};
