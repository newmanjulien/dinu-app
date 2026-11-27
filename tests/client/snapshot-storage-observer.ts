import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { vi } from 'vitest';

// Observe real storage work in an isolated IndexedDB factory. Call close before
// restoring mocks/globals so asynchronous writes finish under the same observer.
export function observeSnapshotStorage() {
	let immutableWrites = 0;
	const transactions = new Set<Promise<void>>();
	const connections = new Set<IDBDatabase>();
	let onImmutableWrite: ((value: { id: string }, tx: IDBTransaction) => void) | undefined;
	vi.stubGlobal('indexedDB', new IDBFactory());
	// Native Node 24 Web Locks coordinate disk access; no live cross-test channel is needed.
	vi.stubGlobal('BroadcastChannel', undefined);
	const registry = new Map<string, string>();
	vi.stubGlobal('localStorage', {
		get length() {
			return registry.size;
		},
		key: (index: number) => [...registry.keys()][index] ?? null,
		getItem: (key: string) => registry.get(key) ?? null,
		setItem: (key: string, value: string) => registry.set(key, value),
		removeItem: (key: string) => registry.delete(key),
		clear: () => registry.clear()
	});

	const transaction = IDBDatabase.prototype.transaction;
	vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
		this: IDBDatabase,
		...args
	) {
		connections.add(this);
		const tx = transaction.apply(this, args);
		const done = new Promise<void>((resolve) => {
			tx.addEventListener('complete', () => resolve(), { once: true });
			tx.addEventListener('abort', () => resolve(), { once: true });
		});
		transactions.add(done);
		void done.then(() => transactions.delete(done));
		return tx;
	});

	const put = IDBObjectStore.prototype.put;
	vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
		this: IDBObjectStore,
		...args
	) {
		const request = put.apply(this, args);
		if (this.name === 'snapshots') {
			immutableWrites++;
			onImmutableWrite?.(args[0], this.transaction);
		}
		return request;
	});

	return {
		get immutableWrites() {
			return immutableWrites;
		},
		// Register before triggering a write; resolve when its real transaction commits.
		committedVersion(versionId: string) {
			return new Promise<void>((resolve, reject) => {
				onImmutableWrite = (value, tx) => {
					if (value.id !== versionId) return;
					onImmutableWrite = undefined;
					tx.addEventListener('complete', () => resolve(), { once: true });
					tx.addEventListener('abort', () => reject(tx.error), { once: true });
				};
			});
		},
		async close() {
			try {
				// Include work queued between transactions before closing connections.
				do {
					await Promise.all(transactions);
					await new Promise<void>((resolve) => setImmediate(resolve));
				} while (transactions.size);
			} finally {
				for (const connection of connections) connection.close();
				onImmutableWrite = undefined;
			}
		}
	};
}
