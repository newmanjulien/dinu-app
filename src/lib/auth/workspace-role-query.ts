import { env } from '$env/dynamic/public';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';

export async function fetchWorkspaceRole(token: string, signal: AbortSignal) {
	const client = new ConvexHttpClient(env.PUBLIC_CONVEX_URL!, {
		logger: false,
		fetch: (input, init) => globalThis.fetch(input, { ...init, signal, cache: 'no-store' })
	});
	client.setAuth(token);
	return client.query(api.accounts.workspaceRole, {});
}
