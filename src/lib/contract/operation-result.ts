import type { ConvexClient } from 'convex/browser';
import type { FunctionArgs } from 'convex/server';
import { assertOperationRetryable, operationResultError } from './operation-recovery';
import { api } from '../../convex/_generated/api';

/** Reattach to the original authorized receipt without changing its key or serialized inputs. */
export function awaitContractOperation<T>(
	client: Pick<ConvexClient, 'onUpdate'>,
	args: FunctionArgs<typeof api.contracts.operationResult>,
	signal: AbortSignal,
	commandIds: readonly string[] = []
): Promise<T> {
	return new Promise((resolve, reject) => {
		let expiry: ReturnType<typeof setTimeout> | undefined;
		let unsubscribe: (() => void) | undefined;
		let settled = false;
		const finish = (run: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(expiry);
			signal.removeEventListener('abort', abort);
			unsubscribe?.();
			run();
		};
		const abort = () => finish(() => reject(signal.reason));
		if (signal.aborted) return abort();
		signal.addEventListener('abort', abort, { once: true });
		try {
			const deadline = Math.min(
				assertOperationRetryable(args.operationId),
				...commandIds.map((id) => assertOperationRetryable(id))
			);
			const expire = () => {
				try {
					assertOperationRetryable(args.operationId);
					for (const id of commandIds) assertOperationRetryable(id);
					expiry = setTimeout(expire, Math.max(1, deadline - Date.now()));
				} catch (error) {
					finish(() => reject(error));
				}
			};
			expiry = setTimeout(expire, Math.max(0, deadline - Date.now()));
			unsubscribe = client.onUpdate(
				api.contracts.operationResult,
				args,
				(value) => {
					try {
						assertOperationRetryable(args.operationId, value?.retryUntil);
						for (const id of commandIds) assertOperationRetryable(id);
					} catch (error) {
						finish(() => reject(error));
						return;
					}
					if (value?.status === 'failed') finish(() => reject(operationResultError(value)));
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
