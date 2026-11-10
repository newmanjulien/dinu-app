import { createClerkClient } from '@clerk/backend';
import { env as privateEnv } from '$env/dynamic/private';
import { env } from '$env/dynamic/public';
import { ReadAttempt, waitForRead } from '$lib/auth/attempt';

/** Optional classification never prolongs the anonymous buyer's request. */
export async function optionalBuyerToken(
	request: Request,
	origin: string,
	fetcher: typeof fetch
): Promise<string | null> {
	const secretKey = privateEnv.CLERK_SECRET_KEY;
	const jwtKey = privateEnv.CLERK_JWT_KEY?.replace(/\\n/g, '\n');
	const publishableKey = env.PUBLIC_CLERK_PUBLISHABLE_KEY;
	if (!secretKey || !jwtKey || !publishableKey) return null;
	// Handshake nonce resolution can fetch through SDK transport without a request signal.
	const url = new URL(request.url);
	if (
		url.searchParams.has('__clerk_handshake') ||
		url.searchParams.has('__clerk_handshake_nonce') ||
		/(?:^|;\s*)__clerk_handshake[^=;]*=/u.test(request.headers.get('cookie') ?? '')
	)
		return null;
	const deadline = Date.now() + 1500;
	const attempt = new ReadAttempt(1500, request.signal);
	const active = () => !attempt.signal.aborted && Date.now() < deadline;
	async function authenticate() {
		if (!active()) return null;
		const clerk = createClerkClient({
			secretKey,
			publishableKey,
			jwtKey,
			telemetry: { disabled: true }
		});
		const state = await clerk.authenticateRequest(request, {
			authorizedParties: [origin],
			acceptsToken: 'session_token'
		});
		if (!active() || !state.isSignedIn) return null;
		const { sessionId } = state.toAuth();
		if (!sessionId || !active()) return null;
		// Same endpoint/version as @clerk/backend 3.23; request-owned transport supports abort.
		const response = await fetcher(
			`https://api.clerk.com/v1/sessions/${encodeURIComponent(sessionId)}/tokens/convex`,
			{
				method: 'POST',
				signal: attempt.signal,
				headers: {
					Authorization: `Bearer ${secretKey}`,
					'Clerk-API-Version': '2026-05-12',
					'User-Agent': 'Dinu buyer link tracking'
				}
			}
		);
		if (!response.ok || !active()) {
			await response.body?.cancel();
			return null;
		}
		const token: unknown = await response.json();
		return active() &&
			token &&
			typeof token === 'object' &&
			'jwt' in token &&
			typeof token.jwt === 'string' &&
			token.jwt.trim()
			? token.jwt
			: null;
	}
	try {
		return await waitForRead(authenticate(), attempt.signal);
	} catch {
		return null;
	} finally {
		attempt.complete();
	}
}
