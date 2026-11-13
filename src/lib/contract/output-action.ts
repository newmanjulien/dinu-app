import { ReadAttempt, waitForRead } from '../auth/attempt';
import { errorCode } from './work-policy';

/** A budget yield continues the same action inputs; a stalled request still times out. */
export async function continueOutputAction<T>(
	run: () => Promise<T>,
	signal: AbortSignal
): Promise<T> {
	while (!signal.aborted) {
		const request = new ReadAttempt(30_000, signal);
		try {
			return await waitForRead(run(), request.signal);
		} catch (error) {
			if (request.signal.aborted || errorCode(error) !== 'OUTPUT_PENDING') throw error;
		} finally {
			request.abort();
		}
		await new Promise<void>((resolve, reject) => {
			const finish = () => {
				signal.removeEventListener('abort', abort);
				resolve();
			};
			const timer = setTimeout(finish, 250);
			const abort = () => {
				clearTimeout(timer);
				signal.removeEventListener('abort', abort);
				reject(signal.reason);
			};
			if (signal.aborted) abort();
			else signal.addEventListener('abort', abort, { once: true });
		});
	}
	throw signal.reason;
}
