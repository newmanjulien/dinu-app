import { createClerkClient } from '@clerk/backend';
import { env as privateEnv } from '$env/dynamic/private';
import { env } from '$env/dynamic/public';
import { ReadAttempt, waitForRead } from '$lib/auth/attempt';

export type BuyerCredential =
	{ kind: 'anonymous' } | { kind: 'account'; token: string } | { kind: 'unknown' };

/** Presence is only a conservative hint; Convex verifies every supplied credential. */
export async function buyerCredential(
	request: Request,
	origin: string,
	fetcher: typeof fetch
): Promise<BuyerCredential> {
	const authorization = request.headers.get('authorization');
	if (authorization !== null) {
		return authorization.length <= 16_384 && /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/u.test(authorization)
			? { kind: 'account', token: authorization.slice(7) }
			: { kind: 'unknown' };
	}
	const url = new URL(request.url);
	const handshake =
		url.searchParams.has('__clerk_handshake') || url.searchParams.has('__clerk_handshake_nonce');
	const cookies = request.headers.get('cookie') ?? '';
	const account =
		/(?:^|;\s*)__(?:session|refresh|clerk_[^=;]*)(?:_[^=;]+)?=/u.test(cookies) ||
		/(?:^|;\s*)__client_uat(?:_[^=;]+)?=(?!0(?:;|$))[^;]+/u.test(cookies);
	if (!handshake && !account) return { kind: 'anonymous' };
	const secretKey = privateEnv.CLERK_SECRET_KEY;
	const jwtKey = privateEnv.CLERK_JWT_KEY?.replace(/\\n/g, '\n');
	const publishableKey = env.PUBLIC_CLERK_PUBLISHABLE_KEY;
	if (!secretKey || !jwtKey || !publishableKey) return { kind: 'unknown' };
	// Handshake nonce resolution can fetch through SDK transport without a request signal.
	if (handshake || /(?:^|;\s*)__clerk_handshake[^=;]*=/u.test(request.headers.get('cookie') ?? ''))
		return { kind: 'unknown' };
	const deadline = Date.now() + 1500;
	const attempt = new ReadAttempt(1500, request.signal);
	const active = () => !attempt.signal.aborted && Date.now() < deadline;
	async function authenticate(): Promise<BuyerCredential> {
		if (!active()) return { kind: 'unknown' };
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
		if (!active() || !state.isSignedIn) return { kind: 'unknown' };
		const { sessionId } = state.toAuth();
		if (!sessionId || !active()) return { kind: 'unknown' };
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
			return { kind: 'unknown' };
		}
		const token: unknown = await response.json();
		return active() &&
			token &&
			typeof token === 'object' &&
			'jwt' in token &&
			typeof token.jwt === 'string' &&
			token.jwt.trim()
			? { kind: 'account', token: token.jwt }
			: { kind: 'unknown' };
	}
	try {
		return await waitForRead(authenticate(), attempt.signal);
	} catch {
		return { kind: 'unknown' };
	} finally {
		attempt.complete();
	}
}

/** Discussion ingress retains its existing explicit account-recovery contract. */
export async function optionalBuyerToken(request: Request, origin: string, fetcher: typeof fetch) {
	const result = await buyerCredential(request, origin, fetcher);
	return result.kind === 'account' ? result.token : null;
}
