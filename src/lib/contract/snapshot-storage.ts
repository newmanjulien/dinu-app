import type { TemplateContent } from '../template/model';
import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
import type { CacheScope } from './browser-storage';
import { validTemplate } from './persisted-values';
import {
	acquirePersistentCache,
	type PersistentCacheLease
} from '$lib/auth/persistent-cache-registry';
export { validSnapshot, validTemplate } from './persisted-values';

export const SNAPSHOT_ENTRIES = 24;
export const SNAPSHOT_BYTES = 32 * 1024 * 1024;
export type SnapshotSize = { bytes: number; immutableBytes: number };
export type SnapshotEntry = SnapshotSize & { data: import('./saved').ReadyContract };
type StoredVersion = { id: string; snapshot: TemplateContent; bytes: number; usedAt: number };
function result<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}
function completed(tx: IDBTransaction) {
	return new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = tx.onerror = () => reject(tx.error);
	});
}

/** Optional disk cache contains only immutable versions, shared by all contracts using them. */
export class SnapshotStorage {
	private closed = false;
	private connection?: IDBDatabase;
	private opening?: Promise<IDBDatabase | undefined>;
	private openingRequest?: IDBOpenDBRequest;
	private lease?: PersistentCacheLease;
	private retryAt = 0;
	private failures = 0;
	private lifetime = new AbortController();
	private queue = Promise.resolve();
	constructor(private readonly scope: CacheScope) {}
	private failed() {
		this.retryAt = Date.now() + Math.min(5000, 250 * 2 ** Math.min(this.failures++, 5));
	}
	private open(): Promise<IDBDatabase | undefined> {
		if (
			this.closed ||
			typeof indexedDB === 'undefined' ||
			!this.scope.userId ||
			!this.scope.membershipId
		)
			return Promise.resolve(undefined);
		this.lease?.touch();
		if (this.connection) return Promise.resolve(this.connection);
		if (this.opening) return this.opening;
		if (Date.now() < this.retryAt) return Promise.resolve(undefined);
		let resolve!: (db?: IDBDatabase) => void;
		const pending = new Promise<IDBDatabase | undefined>((done) => {
			resolve = done;
		});
		this.opening = pending;
		let settled = false;
		const finish = (db?: IDBDatabase) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(db);
		};
		const timer = setTimeout(() => finish(), 250);
		void (async () => {
			const lease =
				this.lease ??
				(await acquirePersistentCache(
					{
						kind: 'contracts',
						databaseName: `${this.scope.namespace}:snapshots`,
						userId: this.scope.userId!,
						membershipId: this.scope.membershipId!
					},
					() => this.close(),
					this.lifetime.signal
				));
			if (!lease || this.closed || !lease.valid()) {
				lease?.release();
				this.opening = undefined;
				this.failed();
				finish();
				return;
			}
			this.lease = lease;
			const request = indexedDB.open(`${this.scope.namespace}:snapshots`, 18);
			this.openingRequest = request;
			request.onupgradeneeded = () => {
				if (this.closed || !lease.valid()) {
					request.transaction?.abort();
					return;
				}
				const db = request.result;
				for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
				db.createObjectStore('snapshots', { keyPath: 'id' }).createIndex('lru', 'usedAt');
			};
			// A blocked native request stays alive; callers can use the network immediately.
			request.onblocked = () => finish();
			request.onerror = () => {
				this.openingRequest = undefined;
				this.opening = undefined;
				this.releaseDisk();
				this.failed();
				finish();
			};
			request.onsuccess = () => {
				this.openingRequest = undefined;
				this.opening = undefined;
				const db = request.result;
				if (this.closed || !lease.valid()) {
					db.close();
					this.releaseDisk();
					finish();
					return;
				}
				this.connection = db;
				this.failures = 0;
				this.retryAt = 0;
				db.onversionchange = () => this.close();
				// Adopt late success even after the optional caller's deadline.
				finish(db);
			};
		})().catch(() => {
			this.opening = undefined;
			this.releaseDisk();
			this.failed();
			finish();
		});
		return pending;
	}
	private async transaction<T>(
		db: IDBDatabase,
		work: (tx: IDBTransaction) => Promise<T>,
		cancel?: AbortSignal
	): Promise<T> {
		const attempt = new ReadAttempt(1000, this.lifetime.signal, cancel);
		let tx: IDBTransaction | undefined;
		const abort = () => {
			try {
				tx?.abort();
			} catch {
				/* Already settled. */
			}
		};
		try {
			attempt.signal.throwIfAborted();
			tx = db.transaction('snapshots', 'readwrite');
			attempt.signal.addEventListener('abort', abort, { once: true });
			const done = completed(tx);
			done.catch(() => {});
			const value = await waitForRead(work(tx), attempt.signal);
			await waitForRead(done, attempt.signal);
			return value;
		} catch (error) {
			abort();
			throw error;
		} finally {
			attempt.complete();
			attempt.signal.removeEventListener('abort', abort);
		}
	}
	async getVersion(
		id: string,
		companyId: string,
		signal?: AbortSignal
	): Promise<TemplateContent | undefined> {
		try {
			const db = await this.open();
			if (!db || signal?.aborted) return;
			return await this.transaction(
				db,
				async (tx) => {
					const store = tx.objectStore('snapshots');
					const cursor = await result(store.openCursor(id));
					if (!cursor) return;
					const entry = cursor.value as StoredVersion;
					if (
						entry.id !== id ||
						!validTemplate(entry.snapshot, companyId) ||
						!Number.isFinite(entry.bytes) ||
						entry.bytes < 0 ||
						entry.bytes > SNAPSHOT_BYTES
					) {
						cursor.delete();
						return;
					}
					cursor.update({ ...entry, usedAt: Date.now() });
					return entry.snapshot;
				},
				signal
			);
		} catch {
			/* Optional storage never prevents an authenticated network read. */
		}
	}
	put(id: string, snapshot: TemplateContent, bytes: number, valid: () => boolean) {
		if (this.closed || !valid() || bytes > SNAPSHOT_BYTES) return;
		this.queue = this.queue
			.then(async () => {
				if (this.closed || !valid()) return;
				const db = await this.open();
				if (!db || !valid()) return;
				await this.transaction(db, async (tx) => {
					const store = tx.objectStore('snapshots');
					const existing = await result(store.get(id));
					if (!valid()) {
						tx.abort();
						return;
					}
					if (existing) return;
					store.put({ id, snapshot, bytes, usedAt: Date.now() } satisfies StoredVersion);
					const entries = (await result(store.getAll())) as StoredVersion[];
					entries.sort((a, b) => a.usedAt - b.usedAt);
					let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
					let count = entries.length;
					for (const entry of entries) {
						if (count <= SNAPSHOT_ENTRIES && total <= SNAPSHOT_BYTES) break;
						store.delete(entry.id);
						total -= entry.bytes;
						count--;
					}
				});
			})
			.catch(() => {});
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		this.lifetime.abort();
		this.connection?.close();
		this.connection = undefined;
		try {
			this.openingRequest?.transaction?.abort();
		} catch {
			/* Already settled. */
		}
		// Keep the deletion lock until an uncancelable native open reaches a terminal event.
		if (!this.openingRequest) this.releaseDisk();
	}
	private releaseDisk() {
		this.lease?.release();
		this.lease = undefined;
	}
}
