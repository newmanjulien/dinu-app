import { localReturn } from './navigation';
import { ReadAttempt, waitForRead } from './attempt';

/** Log-in requests for the same session share one replaceable navigation. */
export class AccountNavigation {
	private sessionId: string | undefined;
	private pending: Promise<void> | undefined;
	private attempt: ReadAttempt | undefined;
	constructor(private navigate: (destination: string) => Promise<void>) {}
	reset() {
		const previous = this.attempt;
		this.sessionId = undefined;
		this.pending = undefined;
		this.attempt = undefined;
		previous?.abort();
	}
	open(sessionId: string, destination: string): Promise<void> {
		if (this.sessionId === sessionId && this.pending) return this.pending;
		this.reset();
		this.sessionId = sessionId;
		const attempt = new ReadAttempt(15_000);
		this.attempt = attempt;
		const pending = waitForRead(
			Promise.resolve().then(() => {
				attempt.signal.throwIfAborted();
				return this.navigate(localReturn(destination));
			}),
			attempt.signal
		);
		this.pending = pending;
		void pending.then(
			() => {
				attempt.complete();
				if (this.attempt === attempt) this.attempt = undefined;
			},
			() => {
				attempt.complete();
				if (this.attempt === attempt) {
					this.sessionId = undefined;
					this.pending = undefined;
					this.attempt = undefined;
				}
			}
		);
		return pending;
	}
}
