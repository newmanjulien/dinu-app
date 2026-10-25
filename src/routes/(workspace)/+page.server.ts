import { env } from '$env/dynamic/public';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';
import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
import type { StartupData } from '$lib/auth/startup-data';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, isDataRequest, fetch }) => {
	const auth = locals.auth?.();
	if (
		isDataRequest ||
		!env.PUBLIC_CONVEX_URL ||
		!auth ||
		!('userId' in auth) ||
		!auth.userId ||
		!('sessionId' in auth) ||
		!auth.sessionId
	)
		return { startup: null };
	const { userId, sessionId } = auth;
	const read = new ReadAttempt(5_000);
	// Stream the result so Clerk, code loading and the backend connection run alongside it.
	const startup = waitForRead(
		(async (): Promise<StartupData | null> => {
			const token = await auth.getToken({ template: 'convex' });
			if (!token || read.signal.aborted) return null;
			const client = new ConvexHttpClient(env.PUBLIC_CONVEX_URL!, {
				logger: false,
				fetch: (input, init) => fetch(input, { ...init, signal: read.signal, cache: 'no-store' })
			});
			client.setAuth(token);
			return { ...(await client.query(api.profiles.startup, {})), userId, sessionId };
		})(),
		read.signal
	)
		.catch(() => null)
		.finally(() => read.complete());
	return { startup };
};
