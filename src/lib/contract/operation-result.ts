import type { ConvexClient } from 'convex/browser';
import type { FunctionArgs } from 'convex/server';
import { ConvexError } from 'convex/values';
import { api } from '../../convex/_generated/api';

/** Reattach to the original authorized receipt without changing its key or serialized inputs. */
export function awaitContractOperation<T>(
	client: Pick<ConvexClient, 'onUpdate'>,
	args: FunctionArgs<typeof api.contracts.operationResult>,
	signal: AbortSignal
): Promise<T> {
	return new Promise((resolve, reject) => {
		let unsubscribe: (() => void) | undefined;
		let settled = false;
		const finish = (run: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener('abort', abort);
			unsubscribe?.();
			run();
		};
		const abort = () => finish(() => reject(signal.reason));
		if (signal.aborted) return abort();
		signal.addEventListener('abort', abort, { once: true });
		try {
			unsubscribe = client.onUpdate(
				api.contracts.operationResult,
				args,
				(value) => {
					if (value?.status === 'failed') finish(() => reject(new ConvexError(value.error)));
					if (value?.status === 'complete')
						finish(() => {
							try {
								resolve(JSON.parse(value.result) as T);
							} catch (cause) {
								reject(cause);
							}
						});
				},
				(cause) => finish(() => reject(cause))
			);
			if (settled) unsubscribe();
		} catch (cause) {
			finish(() => reject(cause));
		}
	});
}
