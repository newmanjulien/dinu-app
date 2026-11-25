import { ConvexError } from 'convex/values';
import { ReadAttempt, waitForRead } from '$lib/auth/attempt';

type Pending<Args, Result> = {
	args: Args;
	result?: Result;
	work?: Promise<Result>;
	uncertain: boolean;
};

/**
 * Shared client-side idempotent action controller.
 *
 * Retains `{ args, uncertain }` across timeouts and transport failures so retries reuse the same
 * `operationId`, while always clearing the cached attempt on any definite `ConvexError` from the
 * server (which runs idempotency receipt lookup before revision checks, proving no prior commit).
 */
export class IdempotentAction<Args, Result> {
	private pending: Pending<Args, Result> | null = null;
	private attempt: ReadAttempt | null = null;

	constructor(private readonly options: { cacheResult?: boolean } = {}) {}

	get hasPending() {
		return this.pending !== null;
	}

	get inFlight() {
		return this.attempt !== null;
	}

	abort() {
		this.attempt?.abort();
		this.attempt = null;
	}

	reset() {
		this.abort();
		this.pending = null;
	}

	async run(params: {
		timeoutMs: number;
		prepare: (signal: AbortSignal) => Promise<Args | null>;
		invoke: (args: Args) => Promise<Result>;
		onDispatch?: () => void;
		finish: (result: Result, signal: AbortSignal) => Promise<void> | void;
		isCurrent?: () => boolean;
	}): Promise<boolean> {
		const attempt = new ReadAttempt(params.timeoutMs);
		this.attempt = attempt;
		const isCurrent = () =>
			!attempt.signal.aborted && this.attempt === attempt && (params.isCurrent?.() ?? true);
		try {
			if (!this.pending) {
				const args = await params.prepare(attempt.signal);
				if (!isCurrent() || args === null) return false;
				this.pending = { args, uncertain: false };
			}
			const entry = this.pending;
			params.onDispatch?.();
			let result: Result;
			if (this.options.cacheResult && entry.result !== undefined) {
				result = entry.result;
			} else {
				const work = params.invoke(entry.args).then(
					(value) => {
						if (this.options.cacheResult && this.pending === entry) entry.result ??= value;
						return value;
					},
					(error: unknown) => {
						if (
							error instanceof ConvexError &&
							this.pending === entry &&
							entry.work === work &&
							entry.result === undefined
						) {
							this.pending = null;
						}
						throw error;
					}
				);
				entry.work = work;
				result = await waitForRead(work, attempt.signal);
			}
			if (!isCurrent()) return false;
			await params.finish(result, attempt.signal);
			if (!isCurrent()) return false;
			if (this.pending === entry) this.pending = null;
			return true;
		} catch (error) {
			if (this.pending && !(error instanceof ConvexError)) {
				this.pending.uncertain = true;
			}
			throw error;
		} finally {
			attempt.complete();
			if (this.attempt === attempt) this.attempt = null;
		}
	}
}
