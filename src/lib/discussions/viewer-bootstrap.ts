import { ReadAttempt } from '../auth/attempt';

/** The lock owns the real cookie-setting response, independently of a mounted consumer.
 * Unsupported browsers fail through existing recovery rather than mint competing credentials.
 */
export async function coordinateDiscussionViewer<T>(
	request: (signal: AbortSignal) => Promise<T>
): Promise<T> {
	if (!navigator.locks)
		throw new Error('This browser cannot securely establish discussion ownership.');
	const owner = new ReadAttempt(15_000);
	try {
		return await navigator.locks.request('dinu-discussion-browser', { signal: owner.signal }, () =>
			request(owner.signal)
		);
	} finally {
		owner.complete();
	}
}
