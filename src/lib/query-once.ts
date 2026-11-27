import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';

export interface SnapshotClient {
	onUpdate<Query extends FunctionReference<'query'>>(
		query: Query,
		args: FunctionArgs<Query>,
		onUpdate: (value: FunctionReturnType<Query>) => void,
		onError?: (error: Error) => unknown
	): (() => void) & { getCurrentValue?: () => FunctionReturnType<Query> | undefined };
}

/** Own the subscription until the first result, error, or cancellation. */
export function queryOnce<Query extends FunctionReference<'query'>>(
	client: SnapshotClient,
	query: Query,
	args: FunctionArgs<Query>,
	signal: AbortSignal
): Promise<FunctionReturnType<Query>> {
	return new Promise((resolve, reject) => {
		let unsubscribe: ReturnType<SnapshotClient['onUpdate']> | undefined;
		let settled = false;
		const finish = (complete: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener('abort', abort);
			unsubscribe?.();
			complete();
		};
		const abort = () => finish(() => reject(signal.reason));
		if (signal.aborted) return abort();
		signal.addEventListener('abort', abort, { once: true });
		try {
			unsubscribe = client.onUpdate(
				query,
				args,
				(value) => finish(() => resolve(value)),
				(error) => finish(() => reject(error))
			);
			const cached = unsubscribe.getCurrentValue?.();
			if (cached !== undefined) finish(() => resolve(cached));
			// Also handle clients that deliver a cached result synchronously.
			if (settled) unsubscribe();
		} catch (error) {
			finish(() => reject(error));
		}
	});
}
