/** A replaceable read attempt. Aborting settles waiters even when a dependency ignores its signal. */
export class ReadAttempt {
	readonly controller = new AbortController();
	readonly signal = this.controller.signal;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private releases: (() => void)[] = [];
	constructor(timeoutMs: number, ...parents: (AbortSignal | undefined)[]) {
		this.timer = setTimeout(() => this.abort(new Error('The request timed out.')), timeoutMs);
		for (const parent of parents) {
			if (!parent) continue;
			if (parent.aborted) {
				this.abort(parent.reason);
				break;
			}
			const abort = () => this.abort(parent.reason);
			parent.addEventListener('abort', abort, { once: true });
			this.releases.push(() => parent.removeEventListener('abort', abort));
		}
	}
	complete() {
		clearTimeout(this.timer);
		this.timer = undefined;
		for (const release of this.releases) release();
		this.releases = [];
	}
	abort(reason: unknown = new Error('The request was replaced.')) {
		this.complete();
		this.controller.abort(reason);
	}
}

export function waitForRead<T>(
	work: PromiseLike<T>,
	...signals: (AbortSignal | undefined)[]
): Promise<T> {
	return new Promise((resolve, reject) => {
		const active = signals.filter((signal) => signal !== undefined);
		const cleanup = () => {
			for (const signal of active) signal.removeEventListener('abort', abort);
		};
		const abort = () => {
			cleanup();
			reject(active.find((signal) => signal.aborted)?.reason);
		};
		if (active.some((signal) => signal.aborted)) abort();
		else for (const signal of active) signal.addEventListener('abort', abort, { once: true });
		Promise.resolve(work).then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error) => {
				cleanup();
				reject(error);
			}
		);
	});
}
