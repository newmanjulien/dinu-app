import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
import { env } from '$env/dynamic/public';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../../convex/_generated/api';
import type { InvitationPreview } from '../../../convex/invitationValidators';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url, locals, setHeaders }) => {
	setHeaders({ 'Referrer-Policy': 'no-referrer' });
	const token = url.searchParams.get('invitation');
	if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
		return {
			token,
			preview: { status: 'unavailable' } satisfies InvitationPreview,
			previewSkipped: false,
			error: ''
		};
	const error = 'Unable to load this invitation. Please try again.';
	const auth = locals.auth?.();
	if (auth && 'sessionId' in auth && auth.sessionId)
		return { token, preview: null, previewSkipped: true, error };
	const previewRequest = (async () => {
		const read = new ReadAttempt(15_000);
		try {
			if (!env.PUBLIC_CONVEX_URL) throw new Error('Invitation lookup is unavailable.');
			const client = new ConvexHttpClient(env.PUBLIC_CONVEX_URL, {
				logger: false,
				fetch: (input, init) =>
					globalThis.fetch(input, { ...init, signal: read.signal, cache: 'no-store' })
			});
			const preview = await waitForRead(
				client.action(api.invitationLinks.preview, { token }),
				read.signal
			);
			return { preview, error: '' };
		} catch {
			return { preview: null, error };
		} finally {
			read.complete();
		}
	})();
	return { token, preview: null, previewRequest, previewSkipped: false, error: '' };
};
