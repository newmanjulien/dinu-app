import type { ConvexClient } from 'convex/browser';

/** A submitted write may still commit after its connection is replaced. */
export class ConnectionInterruptedError extends Error {
	constructor() {
		super('Connection interrupted. Reconnect and check the latest state before trying again.');
		this.name = 'ConnectionInterruptedError';
	}
}

type RequestMethod = 'query' | 'mutation' | 'action';

/** Stable reactive context, with imperative requests scoped to one client lifetime. */
export class ConvexConnection {
	current: ConvexClient;
	readonly client: ConvexClient;
	private pending = new Set<(error: ConnectionInterruptedError) => void>();
	private closed = false;

	constructor(initial: ConvexClient) {
		this.current = $state.raw(initial);
		this.client = new Proxy(initial, {
			get: (_target, property) => {
				if (property === 'query' || property === 'mutation' || property === 'action')
					return (...args: unknown[]) => this.request(property, args);
				if (property === 'close') return () => this.close();
				// Reading the current client makes subscription effects track replacement.
				const current = this.current;
				const value = Reflect.get(current, property, current);
				return typeof value === 'function' ? value.bind(current) : value;
			}
		});
	}

	private request(method: RequestMethod, args: unknown[]): Promise<unknown> {
		if (this.closed) return Promise.reject(new ConnectionInterruptedError());
		const current = this.current;
		return new Promise((resolve, reject) => {
			const interrupt = (error: ConnectionInterruptedError) => {
				this.pending.delete(interrupt);
				reject(error);
			};
			this.pending.add(interrupt);
			const settle = (deliver: (value: unknown) => void, value: unknown) => {
				if (this.pending.delete(interrupt)) deliver(value);
			};
			try {
				// Both handlers consume late SDK outcomes after interruption.
				Promise.resolve(Reflect.apply(current[method], current, args)).then(
					(value) => settle(resolve, value),
					(error) => settle(reject, error)
				);
			} catch (error) {
				settle(reject, error);
			}
		});
	}

	private interrupt() {
		const error = new ConnectionInterruptedError();
		for (const cancel of this.pending) cancel(error);
	}

	replace(next: ConvexClient): Promise<void> {
		if (this.closed) throw new Error('Cannot replace a closed Convex session.');
		this.interrupt();
		const previous = this.current;
		this.current = next;
		return previous.close();
	}

	close(): Promise<void> {
		if (this.closed) return Promise.resolve();
		this.closed = true;
		this.interrupt();
		return this.current.close();
	}
}
