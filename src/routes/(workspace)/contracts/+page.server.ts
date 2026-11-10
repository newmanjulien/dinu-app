import { env } from '$env/dynamic/public';
import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
import type { StartupData, StartupHome } from '$lib/auth/startup-data';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../convex/_generated/api';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, isDataRequest }) => {
	const auth = locals.auth?.();
	const convexUrl = env.PUBLIC_CONVEX_URL;
	if (
		isDataRequest ||
		!convexUrl ||
		!auth ||
		!('userId' in auth) ||
		!auth.userId ||
		!('sessionId' in auth) ||
		!auth.sessionId
	)
		return { startup: null, startupHome: null };
	const { userId, sessionId } = auth;
	const token = auth.getToken({ template: 'convex' });
	function assist<T>(query: (client: ConvexHttpClient) => Promise<T>) {
		const read = new ReadAttempt(5_000);
		return waitForRead(
			(async () => {
				const value = await token;
				if (!value || read.signal.aborted) return null;
				const client = new ConvexHttpClient(convexUrl!, {
					logger: false,
					fetch: (input, init) =>
						globalThis.fetch(input, { ...init, signal: read.signal, cache: 'no-store' })
				});
				client.setAuth(value);
				return { ...(await query(client)), userId, sessionId };
			})(),
			read.signal
		)
			.catch(() => null)
			.finally(() => read.complete());
	}
	const startup: Promise<StartupData | null> = assist(async (client) => ({
		viewer: await client.query(api.accounts.viewer, {})
	}));
	const startupHome: Promise<StartupHome | null> = assist((client) =>
		client.query(api.accounts.startupHome, {})
	);
	return { startup, startupHome };
};
