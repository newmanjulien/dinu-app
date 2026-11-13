import { env } from '$env/dynamic/public';
import { waitForClerkScript } from './clerk-script';
import { ReadAttempt, waitForRead } from './attempt';

type Clerk = NonNullable<Window['Clerk']>;
let pending: { attempt: ReadAttempt; promise: Promise<Clerk> } | undefined;
let sdkLoad: { clerk: Clerk; promise: Promise<void> } | undefined;

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
						promise: clerk.load({ telemetry: false, signInUrl: '/login', signUpUrl: '/join' })
					};
					const owned = load;
					const release = () => {
						if (sdkLoad === owned) sdkLoad = undefined;
					};
					void load.promise.then(release, release);
				}
				await waitForRead(load.promise, attempt.signal);
				if (load.clerk !== clerk) throw new Error('Account sign-in changed. Please try again.');
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

/** Reuse an existing dashboard session without opening a sign-in flow. */
export async function existingBuyerAccount(signal: AbortSignal) {
	const publishableKey = env.PUBLIC_CLERK_PUBLISHABLE_KEY;
	if (!publishableKey) throw new Error('Account sign-in is unavailable. Your draft is still here.');
	pending ??= initialize(publishableKey);
	return waitForRead(pending.promise, signal);
}

export async function refreshBuyerAccount(signal: AbortSignal) {
	const clerk = await existingBuyerAccount(signal);
	if (!clerk.session)
		throw new Error('Reconnect your account to comment. Your draft is still here.');
	const token = await waitForRead(
		clerk.session.getToken({ template: 'convex', skipCache: true }),
		signal
	);
	if (!token) throw new Error('Account verification failed. Your draft is still here.');
	return token;
}
