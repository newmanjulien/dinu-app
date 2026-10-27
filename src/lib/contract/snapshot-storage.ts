import { concessionReviews } from '../../convex/contractValidators';
import { baselineBlock } from '../../convex/sourceValidators';
import { historicalItem } from '../../convex/playbookValidators';
import type { ValidatorJSON } from 'convex/values';
import type { ContractSnapshotResult, ContractSnapshot } from './saved';
import { CACHE_NAMESPACE } from './browser-storage';
import { ReadAttempt, waitForRead } from '$lib/auth/attempt';

export type ReadyContract = Extract<ContractSnapshotResult, { status: 'ready' }>;
export const SNAPSHOT_ENTRIES = 24;
export const SNAPSHOT_BYTES = 32 * 1024 * 1024;
export type SnapshotSize = { bytes: number; immutableBytes: number };
export type SnapshotEntry = SnapshotSize & { data: ReadyContract };
export type SnapshotMetadata = SnapshotSize & { contract: ReadyContract['contract'] };
type RepairTarget =
	{ store: 'metadata'; id: string } | { store: 'snapshots'; id: string; companyId: string };
type LruEntry = { id: string; versionId: string; bytes: number; immutableBytes: number };
type Write = (
	| { kind: 'put'; entry: SnapshotEntry }
	| { kind: 'update'; contract: ReadyContract['contract']; bytes: number }
	| { kind: 'delete' }
	| { kind: 'repair'; target: RepairTarget }
) & { valid: () => boolean };
const writeBytes = (write: Write) =>
	write.kind === 'put' ? write.entry.bytes : write.kind === 'update' ? write.bytes : 0;
type StoredSnapshot = { id: string; snapshot: ReadyContract['snapshot'] };
type StoredMetadata = {
	id: string;
	contract: ReadyContract['contract'];
	bytes: number;
	immutableBytes: number;
	usedAt: number;
};
// Convex exposes these runtime shapes but omits the getter from its public declarations.
const blockShape = (baselineBlock as unknown as { json: ValidatorJSON }).json;
const itemShape = (historicalItem as unknown as { json: ValidatorJSON }).json;
const reviewsShape = (concessionReviews as unknown as { json: ValidatorJSON }).json;
function matches(value: unknown, shape: ValidatorJSON): boolean {
	switch (shape.type) {
		case 'string':
		case 'id':
			return typeof value === 'string';
		case 'number':
			return typeof value === 'number' && Number.isFinite(value);
		case 'boolean':
			return typeof value === 'boolean';
		case 'literal':
			return value === shape.value;
		case 'null':
			return value === null;
		case 'union':
			return shape.value.some((part) => matches(value, part));
		case 'array':
			return Array.isArray(value) && value.every((part) => matches(part, shape.value));
		case 'record':
			return (
				!!value &&
				typeof value === 'object' &&
				!Array.isArray(value) &&
				Object.values(value).every((part) => matches(part, shape.values.fieldType))
			);
		case 'object':
			return (
				!!value &&
				typeof value === 'object' &&
				!Array.isArray(value) &&
				Object.entries(shape.value).every(
					([key, field]) =>
						(field.optional && (value as Record<string, unknown>)[key] === undefined) ||
						matches((value as Record<string, unknown>)[key], field.fieldType)
				)
			);
		default:
			return false;
	}
}
// Templates are immutable. Only reuse validation for the exact object and company.
const validatedTemplates = new WeakMap<object, string>();
export function validTemplate(value: unknown, companyId: string): value is ContractSnapshot {
	if (!value || typeof value !== 'object') return false;
	if (validatedTemplates.get(value) === companyId) return true;
	const snapshot = value as ContractSnapshot;
	const valid =
		Number.isSafeInteger(snapshot.blockCount) &&
		Number.isSafeInteger(snapshot.itemCount) &&
		Array.isArray(snapshot.blocks) &&
		Array.isArray(snapshot.items) &&
		snapshot.blockCount === snapshot.blocks.length &&
		snapshot.itemCount === snapshot.items.length &&
		snapshot.blocks.every((block) => matches(block, blockShape)) &&
		snapshot.items.every(
			(item) => !!item && item.companyId === companyId && matches(item, itemShape)
		);
	if (valid) validatedTemplates.set(value, companyId);
	return valid;
}
export function validSnapshot(value: unknown, id: string): value is ReadyContract {
	if (!value || typeof value !== 'object') return false;
	const data = value as ReadyContract;
	return (
		data.status === 'ready' &&
		data.id === id &&
		validContract(data.contract, id) &&
		validTemplate(data.snapshot, data.contract.companyId)
	);
}
function validContract(value: unknown, id: string): value is ReadyContract['contract'] {
	const contract = value as ReadyContract['contract'] | undefined;
	return (
		!!contract &&
		typeof contract.creatorId === 'string' &&
		contract._id === id &&
		typeof contract.companyName === 'string' &&
		Number.isFinite(contract._creationTime) &&
		Number.isFinite(contract.savedAt) &&
		typeof contract.templateVersionId === 'string' &&
		typeof contract.companyId === 'string' &&
		(contract.lastOperationId === undefined || typeof contract.lastOperationId === 'string') &&
		Number.isSafeInteger(contract.revision) &&
		contract.revision >= 0 &&
		matches(contract.reviews, reviewsShape) &&
		!!contract.selectedConcessions &&
		typeof contract.selectedConcessions === 'object' &&
		!Array.isArray(contract.selectedConcessions) &&
		Object.values(contract.selectedConcessions).every((choice) => typeof choice === 'string')
	);
}
function validMetadata(value: unknown, id: string): value is StoredMetadata {
	const metadata = value as StoredMetadata | undefined;
	return (
		!!metadata &&
		metadata.id === id &&
		validContract(metadata.contract, id) &&
		Number.isFinite(metadata.bytes) &&
		metadata.bytes >= 0 &&
		metadata.bytes <= SNAPSHOT_BYTES &&
		Number.isFinite(metadata.immutableBytes) &&
		metadata.immutableBytes >= 0 &&
		metadata.immutableBytes <= metadata.bytes &&
		Number.isFinite(metadata.usedAt)
	);
}
function result<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}
function completed(transaction: IDBTransaction) {
	return new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = transaction.onerror = () => reject(transaction.error);
	});
}
/** Independent disk LRU. Immutable content and frequently updated metadata have separate stores. */
export class SnapshotStorage {
	private namespace = CACHE_NAMESPACE;
	private closed = false;
	private database: Promise<IDBDatabase | undefined> | undefined;
	private lifetime = new AbortController();
	private pending = new Map<string, Write>();
	private active: readonly Write[] = [];
	private writing = false;
	private open() {
		if (this.closed) return Promise.resolve(undefined);
		return (this.database ??= new Promise((resolve) => {
			const opening = new ReadAttempt(250);
			let settled = false;
			const finish = (db?: IDBDatabase) => {
				if (settled) {
					db?.close();
					return;
				}
				settled = true;
				opening.complete();
				opening.signal.removeEventListener('abort', failed);
				this.lifetime.signal.removeEventListener('abort', failed);
				resolve(db);
			};
			const failed = () => finish();
			opening.signal.addEventListener('abort', failed, { once: true });
			this.lifetime.signal.addEventListener('abort', failed, { once: true });
			try {
				const request = indexedDB.open(`${this.namespace}:snapshots`, 5);
				request.onupgradeneeded = () => {
					// Rebuild the optional cache with one immutable record per version.
					for (const name of ['snapshots', 'metadata'])
						if (request.result.objectStoreNames.contains(name))
							request.result.deleteObjectStore(name);
					request.result.createObjectStore('snapshots', { keyPath: 'id' });
					request.result
						.createObjectStore('metadata', { keyPath: 'id' })
						.createIndex('lru', [
							'usedAt',
							'id',
							'contract.templateVersionId',
							'bytes',
							'immutableBytes'
						]);
				};
				request.onblocked = request.onerror = failed;
				request.onsuccess = () => {
					request.result.onversionchange = () => this.close();
					finish(request.result);
				};
			} catch {
				failed();
			}
		}));
	}
	private async transaction<T>(
		db: IDBDatabase,
		mode: IDBTransactionMode,
		work: (tx: IDBTransaction) => Promise<T>,
		cancel?: AbortSignal
	): Promise<T> {
		const attempt = new ReadAttempt(1000, this.lifetime.signal, cancel);
		const signal = attempt.signal;
		let tx: IDBTransaction | undefined;
		const abort = () => {
			try {
				tx?.abort();
			} catch {
				/* Already settled. */
			}
		};
		try {
			signal.throwIfAborted();
			tx = db.transaction(['snapshots', 'metadata'], mode);
			signal.addEventListener('abort', abort, { once: true });
			const done = completed(tx);
			done.catch(() => {});
			const value = await waitForRead(work(tx), signal);
			await waitForRead(done, signal);
			return value;
		} catch (error) {
			abort();
			throw error;
		} finally {
			attempt.complete();
			signal.removeEventListener('abort', abort);
		}
	}
	/** Read only mutable metadata; immutable content goes through the shared version loader. */
	async getMetadata(id: string, signal?: AbortSignal): Promise<SnapshotMetadata | undefined> {
		try {
			const db = await this.open();
			if (!db || signal?.aborted) return;
			const metadata = await this.transaction(
				db,
				'readonly',
				(tx) => result<StoredMetadata | undefined>(tx.objectStore('metadata').get(id)),
				signal
			);
			if (signal?.aborted) return;
			if (validMetadata(metadata, id)) return metadata;
			if (metadata) this.repair({ store: 'metadata', id });
		} catch {
			// Optional storage never prevents an authenticated network read.
		}
	}
	async getVersion(
		id: string,
		companyId: string,
		signal?: AbortSignal
	): Promise<ContractSnapshot | undefined> {
		try {
			const db = await this.open();
			if (!db || signal?.aborted) return;
			const entry = await this.transaction(
				db,
				'readonly',
				(tx) => result<StoredSnapshot | undefined>(tx.objectStore('snapshots').get(id)),
				signal
			);
			if (signal?.aborted) return;
			if (entry?.id === id && validTemplate(entry.snapshot, companyId)) return entry.snapshot;
			if (entry) this.repair({ store: 'snapshots', id, companyId });
		} catch {
			// Optional storage never prevents an authenticated network read.
		}
	}
	private repair(target: RepairTarget) {
		this.enqueue(`repair:${target.store}:${target.id}`, {
			kind: 'repair',
			target,
			valid: () => true
		});
	}

	close() {
		this.closed = true;
		this.pending.clear();
		this.lifetime.abort();
		void this.database?.then((db) => db?.close());
	}
	private enqueue(id: string, write: Write) {
		if (this.closed || !write.valid()) return;
		const previous = this.pending.get(id);
		if (write.kind === 'update' && previous?.kind === 'delete') return;
		if (write.kind === 'update' && previous?.kind === 'put') {
			write = {
				kind: 'put',
				valid: write.valid,
				entry: {
					data: { ...previous.entry.data, contract: write.contract },
					immutableBytes: previous.entry.immutableBytes,
					bytes: previous.entry.immutableBytes + write.bytes
				}
			};
		}
		this.pending.delete(id);
		this.pending.set(id, write);
		// Include the active payload: stalled storage must not retain an unbounded write backlog.
		while (
			this.pending.size &&
			(this.pending.size + this.active.length > SNAPSHOT_ENTRIES ||
				this.queuedBytes() > SNAPSHOT_BYTES)
		) {
			const oldest = this.pending.keys().next().value!;
			this.pending.delete(oldest);
		}
		if (!this.writing) void this.drain();
	}
	private async drain() {
		this.writing = true;
		try {
			// Open before taking a payload out of the bounded queue.
			const db = await this.open();
			if (!db) {
				this.pending.clear();
				return;
			}
			while (!this.closed && this.pending.size) {
				const batch = [...this.pending];
				this.pending.clear();
				this.active = batch.map(([, write]) => write);
				try {
					await this.transaction(db, 'readwrite', async (tx) => {
						for (const [id, write] of batch) if (write.valid()) await this.write(tx, id, write);
						await this.enforceLimits(tx);
					});
				} catch {
					/* Optional cache; failed writes do not affect confirmed server state. */
				} finally {
					this.active = [];
				}
			}
		} finally {
			this.writing = false;
		}
	}
	private queuedBytes() {
		const versions = new Map<string, number>();
		let bytes = 0;
		for (const write of [...this.pending.values(), ...this.active]) {
			bytes += writeBytes(write);
			if (write.kind === 'put') {
				bytes -= write.entry.immutableBytes;
				versions.set(write.entry.data.contract.templateVersionId, write.entry.immutableBytes);
			}
		}
		return bytes + [...versions.values()].reduce((sum, size) => sum + size, 0);
	}
	private async write(tx: IDBTransaction, id: string, write: Write) {
		const store = tx.objectStore('metadata');
		const snapshots = tx.objectStore('snapshots');
		if (write.kind === 'repair') {
			// Recheck under the write lock: a newer valid record must survive delayed repair.
			const repair = write.target;
			const target = tx.objectStore(repair.store);
			const current = await result(target.get(repair.id));
			if (
				current &&
				!(repair.store === 'metadata'
					? validMetadata(current, repair.id)
					: current.id === repair.id && validTemplate(current.snapshot, repair.companyId))
			)
				target.delete(repair.id);
		} else if (write.kind === 'delete') store.delete(id);
		else if (write.kind === 'put') {
			const { data, bytes, immutableBytes } = write.entry;
			const versionId = data.contract.templateVersionId;
			const missing = (await result(snapshots.getKey(versionId))) === undefined;
			if (!write.valid()) return;
			if (missing) snapshots.put({ id: versionId, snapshot: data.snapshot });
			store.put({ id, contract: data.contract, bytes, immutableBytes, usedAt: Date.now() });
		} else {
			const metadata = await result<StoredMetadata | undefined>(store.get(id));
			if (!validMetadata(metadata, id) || !write.valid()) return;
			store.put({
				...metadata,
				contract: write.contract,
				bytes: metadata.immutableBytes + write.bytes,
				usedAt: Date.now()
			});
		}
	}

	private async enforceLimits(tx: IDBTransaction) {
		const store = tx.objectStore('metadata');
		const entries = await new Promise<LruEntry[]>((resolve, reject) => {
			const entries: LruEntry[] = [];
			const request = store.index('lru').openKeyCursor();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const cursor = request.result;
				if (!cursor) return resolve(entries);
				const [usedAt, id, versionId, bytes, immutableBytes] = cursor.key as [
					number,
					string,
					string,
					number,
					number
				];
				if (
					Number.isFinite(usedAt) &&
					typeof id === 'string' &&
					id === cursor.primaryKey &&
					typeof versionId === 'string' &&
					Number.isFinite(bytes) &&
					bytes >= 0 &&
					bytes <= SNAPSHOT_BYTES &&
					Number.isFinite(immutableBytes) &&
					immutableBytes >= 0 &&
					immutableBytes <= bytes
				)
					entries.push({ id, versionId, bytes, immutableBytes });
				else store.delete(cursor.primaryKey);
				cursor.continue();
			};
		});
		// Missing index fields are corruption too. Inspect keys, never full contract payloads.
		const indexed = new Set(entries.map((entry) => entry.id));
		for (const id of await result(store.getAllKeys()))
			if (typeof id !== 'string' || !indexed.has(id)) store.delete(id);
		const versions = new Map<string, { bytes: number; references: number }>();
		let total = 0;
		for (const entry of entries) {
			total += entry.bytes - entry.immutableBytes;
			const id = entry.versionId;
			const version = versions.get(id);
			if (version) version.references++;
			else {
				versions.set(id, { bytes: entry.immutableBytes, references: 1 });
				total += entry.immutableBytes;
			}
		}
		let count = entries.length;
		for (const entry of entries) {
			if (count <= SNAPSHOT_ENTRIES && total <= SNAPSHOT_BYTES) break;
			store.delete(entry.id);
			total -= entry.bytes - entry.immutableBytes;
			const versionId = entry.versionId;
			const version = versions.get(versionId)!;
			if (--version.references === 0) {
				total -= version.bytes;
				versions.delete(versionId);
			}
			count--;
		}
		// Remove orphaned versions after deletion, replacement or LRU eviction.
		const snapshots = tx.objectStore('snapshots');
		for (const id of await result(snapshots.getAllKeys()))
			if (!versions.has(String(id))) snapshots.delete(id);
	}
	put(entry: SnapshotEntry, valid: () => boolean) {
		const { data, bytes, immutableBytes } = entry;
		this.enqueue(data.id, { kind: 'put', entry: { data, bytes, immutableBytes }, valid });
	}
	updateContract(
		id: string,
		contract: ReadyContract['contract'],
		bytes: number,
		valid: () => boolean
	) {
		this.enqueue(id, { kind: 'update', contract, bytes, valid });
	}
	delete(id: string, valid: () => boolean = () => true) {
		this.enqueue(id, { kind: 'delete', valid });
	}
}
