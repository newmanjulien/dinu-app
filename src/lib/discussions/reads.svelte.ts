import type { FunctionArgs } from 'convex/server';
import type { api } from '../../convex/_generated/api';

export type SeenMessage = FunctionArgs<typeof api.discussions.markSeen>['messages'][number];
type Pending = {
	message: SeenMessage;
	current: () => boolean;
	promise: Promise<boolean>;
	resolve: (seen: boolean) => void;
};

/** Session-local batching only; Convex owns the shared read state. */
export class DiscussionReads {
	identity = $state<string>();
	private send?: (messages: SeenMessage[]) => Promise<boolean>;
	private pending = new Map<string, Pending>();
	private inFlight = new Map<string, Pending>();
	private completed = new Map<string, number>();
	private timer?: ReturnType<typeof setTimeout>;
	private epoch = 0;
	configure(identity?: string, send?: (messages: SeenMessage[]) => Promise<boolean>) {
		this.send = send;
		if (identity === this.identity) return;
		this.identity = identity;
		this.epoch++;
		clearTimeout(this.timer);
		this.timer = undefined;
		for (const item of this.pending.values()) item.resolve(false);
		this.pending.clear();
		this.inFlight.clear();
		this.completed.clear();
	}
	seen(message: SeenMessage, current: () => boolean): Promise<boolean> {
		if (!this.identity || !current()) return Promise.resolve(false);
		if (this.completed.get(message.messageId) === message.revision) return Promise.resolve(true);
		const key = JSON.stringify(message);
		const previous = this.inFlight.get(key);
		if (previous) return previous.promise;
		let resolve!: Pending['resolve'];
		const promise = new Promise<boolean>((done) => (resolve = done));
		const item = { message, current, promise, resolve };
		this.pending.set(key, item);
		this.inFlight.set(key, item);
		this.timer ??= setTimeout(() => void this.flush(), 0);
		return promise;
	}
	private async flush() {
		this.timer = undefined;
		const epoch = this.epoch;
		const send = this.send;
		const entries = [...this.pending.entries()];
		this.pending.clear();
		for (let offset = 0; offset < entries.length; offset += 20) {
			const batch = entries.slice(offset, offset + 20);
			const eligible = batch.filter(([, item]) => epoch === this.epoch && item.current());
			let accepted = false;
			try {
				if (send && eligible.length)
					accepted = await send(eligible.map(([, item]) => item.message));
			} catch {
				// Leave server state unread; visible text can retry after recovery.
			}
			for (const [key, item] of batch) {
				const seen =
					accepted && epoch === this.epoch && eligible.some(([, entry]) => entry === item);
				if (seen) {
					this.completed.set(item.message.messageId, item.message.revision);
					if (this.completed.size > 500) this.completed.delete(this.completed.keys().next().value!);
				}
				if (this.inFlight.get(key) === item) this.inFlight.delete(key);
				item.resolve(seen);
			}
		}
	}
}
