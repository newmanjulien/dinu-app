import { env } from '$env/dynamic/public';
import { waitForClerkScript } from './clerk-script';
import { waitForRead } from './attempt';

let pending: Promise<NonNullable<Window['Clerk']>> | undefined;
/** Loaded only by a requested discussion interaction; the SDK maintains its session thereafter. */
export async function refreshBuyerAccount(signal: AbortSignal) {
	const publishableKey = env.PUBLIC_CLERK_PUBLISHABLE_KEY;
	if (!publishableKey) throw new Error('Account sign-in is unavailable. Your draft is still here.');
	pending ??= (async () => {
		const clerk = await waitForClerkScript(publishableKey, AbortSignal.timeout(15_000));
		await clerk.load({ telemetry: false, signInUrl: '/login', signUpUrl: '/join' });
		return clerk;
	})().catch((error) => {
		pending = undefined;
		throw error;
	});
	const clerk = await waitForRead(pending, signal);
	if (!clerk.session)
		throw new Error('Reconnect your account to comment. Your draft is still here.');
	const token = await waitForRead(
		clerk.session.getToken({ template: 'convex', skipCache: true }),
		signal
	);
	if (!token) throw new Error('Account verification failed. Your draft is still here.');
	return token;
}
