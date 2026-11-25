import { env } from '$env/dynamic/public';
import { waitForClerkScript } from './clerk-script';
import { CLERK_AUTH_URLS } from './navigation';
import { ReadAttempt, waitForRead } from './attempt';

type Clerk = NonNullable<Window['Clerk']>;
type AccountSession = NonNullable<Clerk['session']>;
let pending: { attempt: ReadAttempt; promise: Promise<Clerk> } | undefined;
let sdkLoad: { clerk: Clerk; promise: Promise<void> } | undefined;
let preparedToken: { session: AccountSession; token: string; expiresAt: number } | undefined;
let tokenLoad:
	| {
			session: AccountSession;
			generation: number;
			startedAt: number;
			promise: Promise<string | null>;
	  }
	| undefined;
let tokenGeneration = 0;

function initialize(publishableKey: string) {
	const attempt = new ReadAttempt(15_000);
	const owner = {
		attempt,
		promise: (async () => {
			const clerk = await waitForClerkScript(publishableKey, attempt.signal);
			attempt.signal.throwIfAborted();
			if (!clerk.loaded) {
				// ClerkJS 6.38.0 cannot cancel or deduplicate an unfinished load. Retain
				// that SDK work across bounded application attempts rather than overlap it.
				let load = sdkLoad;
				if (!load) {
					load = sdkLoad = {
						clerk,
						promise: clerk.load({ telemetry: false, ...CLERK_AUTH_URLS })
					};
					const owned = load;
					const release = () => {
						if (sdkLoad === owned) sdkLoad = undefined;
					};
					void load.promise.then(release, release);
				}
				await waitForRead(load.promise, attempt.signal);
				if (load.clerk !== clerk) throw new Error('Account session changed. Please try again.');
			}
			attempt.signal.throwIfAborted();
			return clerk;
		})().finally(() => attempt.complete())
	};
	void owner.promise.catch(() => {
		if (pending === owner) pending = undefined;
	});
	return owner;
}

/** Reuse an existing dashboard session without opening a log-in flow. */
export async function existingBuyerAccount(signal: AbortSignal) {
	const publishableKey = env.PUBLIC_CLERK_PUBLISHABLE_KEY;
	if (!publishableKey) throw new Error('Account log-in is unavailable.');
	pending ??= initialize(publishableKey);
	return waitForRead(pending.promise, signal);
}

function tokenExpiresAt(token: string) {
	try {
		const payload: unknown = JSON.parse(
			atob(token.split('.')[1].replace(/-/gu, '+').replace(/_/gu, '/'))
		);
		return payload &&
			typeof payload === 'object' &&
			'exp' in payload &&
			typeof payload.exp === 'number'
			? payload.exp * 1000
			: 0;
	} catch {
		return 0;
	}
}

async function accountToken(signal: AbortSignal, forceRefresh = false) {
	const clerk = await existingBuyerAccount(signal);
	const session = clerk.session;
	if (!session) throw new Error('Reconnect your account to comment.');
	if (forceRefresh) preparedToken = undefined;
	if (
		!forceRefresh &&
		preparedToken?.session === session &&
		preparedToken.expiresAt > Date.now() + 10_000
	)
		return preparedToken.token;
	let load = tokenLoad;
	if (forceRefresh || !load || load.session !== session || Date.now() - load.startedAt > 15_000) {
		load = {
			session,
			generation: ++tokenGeneration,
			startedAt: Date.now(),
			promise: session.getToken({ template: 'convex', skipCache: true })
		};
		tokenLoad = load;
		const owned = load;
		const release = () => {
			if (tokenLoad === owned) tokenLoad = undefined;
		};
		void load.promise.then(release, release);
	}
	const token = await waitForRead(load.promise, signal);
	if (clerk.session !== session) throw new Error('Your account session changed.');
	if (!token) throw new Error('Account verification failed.');
	if (load.generation === tokenGeneration)
		preparedToken = { session, token, expiresAt: tokenExpiresAt(token) };
	return token;
}

/** Start the same bounded credential work that a later account post will await. */
export async function prepareBuyerAccount(signal: AbortSignal) {
	return tokenExpiresAt(await accountToken(signal));
}

export function refreshBuyerAccount(signal: AbortSignal, forceRefresh = false) {
	return accountToken(signal, forceRefresh);
}
