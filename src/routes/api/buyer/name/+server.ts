import { env as privateEnv } from '$env/dynamic/private';
import { env } from '$env/dynamic/public';
import { readTextBody } from '$lib/http-body';
import { isBuyerCode } from '$lib/buyer/token';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, url, fetch }) => {
	const headers = { 'Cache-Control': 'private, no-store' };
	const response = (status: number) => new Response(null, { status, headers });
	if (request.headers.get('origin') !== url.origin) return response(403);
	if (!privateEnv.BUYER_LINK_INGEST_SECRET || !env.PUBLIC_CONVEX_SITE_URL) return response(503);
	const reader = request.body?.getReader();
	if (!reader) return response(400);
	try {
		const text = await readTextBody(reader, 512);
		const body: unknown = text === null ? null : JSON.parse(text);
		if (
			!body ||
			typeof body !== 'object' ||
			Array.isArray(body) ||
			Object.keys(body).length !== 1 ||
			!('token' in body) ||
			typeof body.token !== 'string' ||
			!isBuyerCode(body.token)
		)
			return response(400);
		const result = await fetch(`${env.PUBLIC_CONVEX_SITE_URL}/buyer/name`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Buyer-Ingest-Secret': privateEnv.BUYER_LINK_INGEST_SECRET
			},
			body: JSON.stringify({ token: body.token }),
			signal: AbortSignal.timeout(12_000)
		});
		return response(result.status);
	} catch {
		return response(503);
	}
};
