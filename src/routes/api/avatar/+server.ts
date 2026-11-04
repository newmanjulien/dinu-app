import { env } from '$env/dynamic/public';
import type { RequestHandler } from './$types';

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export const POST: RequestHandler = async ({ locals, request, url }) => {
	const token = await locals.auth?.().getToken({ template: 'convex' });
	if (!token) return new Response('Sign in required.', { status: 401 });
	if (!env.PUBLIC_CONVEX_URL)
		return new Response('Missing backend configuration.', { status: 503 });
	const contentType = request.headers.get('content-type') ?? '';
	if (Number(request.headers.get('content-length')) > AVATAR_MAX_BYTES)
		return new Response('Avatar image must be 2 MB or smaller.', { status: 413 });
	if (!request.body) return new Response('Avatar image is required.', { status: 400 });
	let received = 0;
	let tooLarge = false;
	const controller = new AbortController();
	const body = request.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, stream) {
				received += chunk.byteLength;
				if (received > AVATAR_MAX_BYTES) {
					tooLarge = true;
					controller.abort();
					stream.error(new Error('Avatar image exceeds the size limit.'));
					return;
				}
				stream.enqueue(chunk);
			}
		})
	);
	const endpoint = new URL(
		'/avatar',
		env.PUBLIC_CONVEX_URL.replace('.convex.cloud', '.convex.site')
	);
	if (url.searchParams.has('membershipId'))
		endpoint.searchParams.set('membershipId', url.searchParams.get('membershipId')!);
	endpoint.searchParams.set('company', String(url.searchParams.get('company') === 'true'));
	try {
		const response = await fetch(endpoint, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
			body,
			signal: controller.signal,
			duplex: 'half'
		} as RequestInit & { duplex: 'half' });
		const headers = new Headers({ 'cache-control': 'no-store' });
		const responseContentType = response.headers.get('content-type');
		if (responseContentType) headers.set('content-type', responseContentType);
		return new Response(response.body, { status: response.status, headers });
	} catch (error) {
		if (tooLarge)
			return new Response('Avatar image must be 2 MB or smaller.', {
				status: 413,
				headers: { 'cache-control': 'no-store' }
			});
		console.error('Unable to contact Convex for avatar upload.', error);
		return new Response('Unable to save your avatar. Try again.', {
			status: 502,
			headers: { 'cache-control': 'no-store' }
		});
	}
};
