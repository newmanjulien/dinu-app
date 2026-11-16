import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
import { ConvexHttpClient } from 'convex/browser';

/** Required, bounded route data read. Callers decide which error state to render. */
export async function readRouteData<T>(
	convexUrl: string,
	requestSignal: AbortSignal,
	read: (client: ConvexHttpClient) => Promise<T>,
	credential?: string
): Promise<T> {
	const attempt = new ReadAttempt(5_000, requestSignal);
	try {
		const client = new ConvexHttpClient(convexUrl, {
			logger: false,
			fetch: (input, init) =>
				globalThis.fetch(input, { ...init, signal: attempt.signal, cache: 'no-store' })
		});
		if (credential) client.setAuth(credential);
		return await waitForRead(read(client), attempt.signal);
	} finally {
		attempt.complete();
	}
}
