import type { MembershipRetirement } from './viewer-session.svelte';
import type { SourceBlock } from '$lib/document/model';
import type { TemplateAudience } from '$lib/playbook/model';
import type { StructureSnapshot, TemplateContentSnapshot } from '$lib/playbook/structure';
import { validTemplate } from '$lib/contract/persisted-values';
import { immutable } from '$lib/immutable';
import { env } from '$env/dynamic/public';
import {
	acquirePersistentCache,
	deletePersistentCache,
	type PersistentCacheLease
} from './persistent-cache-registry';

export type WorkspaceReadScope = Readonly<{
	profileId: string;
	membershipId: string;
	companyId: string;
}>;
export function workspaceReadDatabaseName(scope: WorkspaceReadScope) {
	return `dinu:workspace-read:v2:${env.PUBLIC_CONVEX_URL ?? ''}:${scope.profileId}:${scope.membershipId}:${scope.companyId}`;
}
const record = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit = 256): value is string =>
	typeof value === 'string' && value.length <= limit;
const id = (value: unknown) => text(value, 256) && value.length > 0;
const number = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;
function encodedBytes(value: unknown): number {
	if (typeof value === 'string') {
		let bytes = 2;
		for (let i = 0; i < value.length; i++) {
			const c = value.charCodeAt(i);
			if (c === 34 || c === 92) bytes += 2;
			else if (c < 32) bytes += [8, 9, 10, 12, 13].includes(c) ? 2 : 6;
			else if (c < 128) bytes++;
			else if (c < 2048) bytes += 2;
			else if (
				c >= 0xd800 &&
				c <= 0xdbff &&
				value.charCodeAt(i + 1) >= 0xdc00 &&
				value.charCodeAt(i + 1) <= 0xdfff
			) {
				bytes += 4;
				i++;
			} else bytes += c >= 0xd800 && c <= 0xdfff ? 6 : 3;
		}
		return bytes;
	}
	if (Array.isArray(value))
		return (
			2 +
			Math.max(0, value.length - 1) +
			value.reduce((size, entry) => size + encodedBytes(entry), 0)
		);
	if (record(value)) {
		const entries = Object.entries(value);
		return (
			2 +
			Math.max(0, entries.length - 1) +
			entries.reduce((size, [key, entry]) => size + encodedBytes(key) + 1 + encodedBytes(entry), 0)
		);
	}
	return String(value).length;
}

const workspaceReadStores = ['templateSources', 'templateDetails'];

const owners = new Set<WorkspaceReadStorage>();

/** Optional storage shared by the retained workspace and both template audiences. */
export class WorkspaceReadStorage {
	private database?: IDBDatabase;
	private opening?: Promise<IDBDatabase | undefined>;
	private releaseOpening?: () => void;
	private closed = false;
	private available = true;
	private generation = 0;
	private resetReady = true;
	private resetBarrier = Promise.resolve();
	private queue = Promise.resolve();
	private transactions = new Set<IDBTransaction>();
	private lifetime = new AbortController();
	private lease?: PersistentCacheLease;
	private openingRequest?: IDBOpenDBRequest;
	private retryAt = 0;
	private openFailures = 0;
	constructor(
		readonly scope: WorkspaceReadScope,
		readonly userId: string
	) {
		owners.add(this);
	}
	private isCurrent(generation: number) {
		return !this.closed && this.available && generation === this.generation;
	}
	/** Hold is reversible; disposal is terminal. All resumed disk work follows the clear. */
	configure(available: boolean) {
		if (this.closed || this.available === available) return;
		this.available = available;
		if (available) return;
		const generation = ++this.generation;
		this.resetReady = false;
		this.abortTransactions();
		this.resetBarrier = this.resetBarrier
			.then(async () => {
				const current = () => !this.closed && generation === this.generation;
				if (!current()) return;
				const db = await this.open();
				if (!db || !current()) return;
				const cleared = await this.runTransaction(
					db,
					workspaceReadStores,
					'readwrite',
					async (tx) => {
						for (const store of workspaceReadStores) tx.objectStore(store).clear();
						return true;
					},
					current
				);
				// A failed optional reset disables disk reuse until a later successful reset.
				if (current()) this.resetReady = cleared === true;
			})
			.catch(() => {});
	}
	private enqueue(run: (generation: number) => Promise<unknown>) {
		const generation = this.generation;
		if (!this.isCurrent(generation)) return;
		this.queue = this.queue
			.then(() => (this.isCurrent(generation) ? run(generation) : undefined))
			.then(() => {})
			.catch(() => {});
	}
	private transaction(db: IDBDatabase, stores: string | string[], mode: IDBTransactionMode) {
		const tx = db.transaction(stores, mode);
		this.transactions.add(tx);
		const release = () => this.transactions.delete(tx);
		tx.addEventListener('complete', release, { once: true });
		tx.addEventListener('abort', release, { once: true });
		return tx;
	}
	private open() {
		if (this.closed || typeof indexedDB === 'undefined') return Promise.resolve(undefined);
		this.lease?.touch();
		if (this.database) return Promise.resolve(this.database);
		if (this.opening) return this.opening;
		if (Date.now() < this.retryAt) return Promise.resolve(undefined);
		let resolveOpen!: (db?: IDBDatabase) => void;
		const attempt = new Promise<IDBDatabase | undefined>((resolve) => {
			resolveOpen = resolve;
		});
		this.opening = attempt;
		let settled = false;
		const finish = (db?: IDBDatabase) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (this.releaseOpening === unavailable) this.releaseOpening = undefined;
			resolveOpen(db);
		};
		const unavailable = () => finish();
		this.releaseOpening = unavailable;
		const timer = setTimeout(unavailable, 250);
		void (async () => {
			const lease =
				this.lease ??
				(await acquirePersistentCache(
					{
						kind: 'workspace',
						databaseName: workspaceReadDatabaseName(this.scope),
						userId: this.userId,
						membershipId: this.scope.membershipId
					},
					() => this.close(),
					this.lifetime.signal
				));
			if (!lease || this.closed || !lease.valid()) {
				lease?.release();
				if (this.opening === attempt) this.opening = undefined;
				this.retryAt = Date.now() + Math.min(5000, 250 * 2 ** Math.min(this.openFailures++, 5));
				unavailable();
				return;
			}
			this.lease = lease;
			try {
				const request = indexedDB.open(workspaceReadDatabaseName(this.scope), 8);
				this.openingRequest = request;
				request.onupgradeneeded = () => {
					if (this.closed || !lease.valid()) {
						request.transaction?.abort();
						return;
					}
					const db = request.result;
					for (const name of [
						'contractDirectory',
						'buyerLinkDirectory',
						'directoryMetadata',
						'projections',
						'templateViews',
						'templateMetadata',
						'templateDetails',
						'templateSources'
					])
						if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
					for (const name of workspaceReadStores)
						if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'key' });
				};
				// Release optional callers, but keep one native request until its blocker closes.
				request.onblocked = unavailable;
				request.onerror = () => {
					this.openingRequest = undefined;
					if (this.closed) this.releaseDisk();
					if (this.opening === attempt) this.opening = undefined;
					this.retryAt = Date.now() + Math.min(5000, 250 * 2 ** Math.min(this.openFailures++, 5));
					unavailable();
				};
				request.onsuccess = () => {
					this.openingRequest = undefined;
					const db = request.result;
					if (this.closed || !lease.valid()) {
						db.close();
						this.releaseDisk();
						unavailable();
						return;
					}
					db.onversionchange = () => this.close();
					// A late successful open is available to the next admitted cache read.
					this.database = db;
					this.openFailures = 0;
					this.retryAt = 0;
					this.opening = undefined;
					finish(db);
				};
			} catch {
				this.opening = undefined;
				unavailable();
			}
		})().catch(() => {
			this.opening = undefined;
			unavailable();
		});
		return attempt;
	}
	/** Only a caller's live fingerprint selects immutable prose from disk. */
	async readTemplateSource(fingerprint: string): Promise<TemplateProse | undefined> {
		return this.storageTransaction(['templateSources'], 'readwrite', async (tx) => {
			const store = tx.objectStore('templateSources');
			const value: unknown = await idbValue(store.get(fingerprint));
			if (!validTemplateSource(value, this.scope.companyId)) {
				store.delete(fingerprint);
				return;
			}
			store.put({ ...value, usedAt: Date.now() });
			return immutable(value.prose) as TemplateProse;
		});
	}
	writeTemplateSource(prose: TemplateProse, valid: () => boolean) {
		this.enqueue(async (generation) => {
			if (!valid() || !prose.templateSourceFingerprint) return;
			const value = {
				version: 1 as const,
				key: prose.templateSourceFingerprint,
				savedAt: Date.now(),
				usedAt: Date.now(),
				prose,
				bytes: 0
			};
			value.bytes = encodedBytes(value) + 64;
			await this.writeImmutable(
				'templateSources',
				value,
				TEMPLATE_SOURCE_BYTES,
				4,
				generation,
				valid
			);
		});
	}
	async readTemplateDetail(
		audience: TemplateAudience,
		structure: StructureSnapshot,
		itemId: string
	): Promise<TemplateContentSnapshot | undefined> {
		const head = structure.items.find((item) => item._id === itemId);
		if (!head) return;
		const key = templateDetailKey(audience, structure, head);
		return this.storageTransaction(['templateDetails'], 'readwrite', async (tx) => {
			const store = tx.objectStore('templateDetails');
			const value: unknown = await idbValue(store.get(key));
			if (
				!validTemplateDetail(value, this.scope.companyId) ||
				!detailMatches(structure, value.snapshot)
			) {
				store.delete(key);
				return;
			}
			store.put({ ...value, usedAt: Date.now() });
			return immutable(value.snapshot);
		});
	}
	forgetTemplateDetail(audience: TemplateAudience, structure: StructureSnapshot, itemId: string) {
		const head = structure.items.find((item) => item._id === itemId);
		if (!head) return;
		this.enqueue((generation) =>
			this.storageTransaction(
				['templateDetails'],
				'readwrite',
				async (tx) => {
					tx.objectStore('templateDetails').delete(templateDetailKey(audience, structure, head));
				},
				generation
			)
		);
	}
	writeTemplateDetail(
		audience: TemplateAudience,
		structure: StructureSnapshot,
		snapshot: TemplateContentSnapshot,
		openedAt: number,
		valid: () => boolean
	) {
		this.enqueue(async (generation) => {
			if (!valid() || snapshot.status !== 'present' || !detailMatches(structure, snapshot)) return;
			const value = {
				version: 1 as const,
				key: templateDetailKey(audience, structure, snapshot.item),
				audience,
				savedAt: Date.now(),
				usedAt: openedAt,
				openedAt,
				snapshot,
				bytes: 0
			};
			value.bytes = encodedBytes(value) + 64;
			await this.writeImmutable(
				'templateDetails',
				value,
				TEMPLATE_DETAIL_BYTES,
				TEMPLATE_DETAIL_COUNT,
				generation,
				valid
			);
		});
	}
	private async writeImmutable(
		storeName: string,
		value: { key: string; bytes: number; usedAt: number },
		byteLimit: number,
		countLimit: number,
		generation: number,
		valid: () => boolean
	) {
		// Reject the candidate before inspecting or charging the eviction budget.
		if (value.bytes > byteLimit) return;
		await this.storageTransaction(
			[storeName],
			'readwrite',
			async (tx) => {
				const store = tx.objectStore(storeName);
				if ((await idbValue(store.getKey(value.key))) !== undefined) return;
				const rows: { key: IDBValidKey; bytes: number; usedAt: number }[] = [];
				await visitCursor(store, (cursor) => {
					const row: unknown = cursor.value;
					if (!record(row) || !number(row.bytes) || !number(row.usedAt)) cursor.delete();
					else rows.push({ key: cursor.primaryKey, bytes: row.bytes, usedAt: row.usedAt });
				});
				rows.sort((a, b) => b.usedAt - a.usedAt);
				let bytes = value.bytes,
					count = 1;
				for (const row of rows) {
					if (count >= countLimit || bytes + row.bytes > byteLimit) store.delete(row.key);
					else {
						count++;
						bytes += row.bytes;
					}
				}
				if (!valid()) {
					tx.abort();
					return;
				}
				store.put(value);
			},
			generation,
			valid
		);
	}
	clearTemplates(audience?: TemplateAudience) {
		this.enqueue((generation) =>
			this.storageTransaction(
				workspaceReadStores,
				'readwrite',
				async (tx) => {
					if (!audience) {
						for (const name of workspaceReadStores) tx.objectStore(name).clear();
						return;
					}
					await visitCursor(tx.objectStore('templateDetails'), (cursor) => {
						if (cursor.value.audience === audience) cursor.delete();
					});
				},
				generation
			)
		);
	}

	private async storageTransaction<T>(
		stores: string[],
		mode: IDBTransactionMode,
		run: (tx: IDBTransaction) => Promise<T>,
		generation = this.generation,
		valid: () => boolean = () => true,
		timeout = 250
	): Promise<T | undefined> {
		const current = () => this.isCurrent(generation) && valid();
		if (!current()) return;
		await this.resetBarrier;
		if (!current() || !this.resetReady) return;
		const db = await this.open();
		if (!db || !current()) return;
		const result = await this.runTransaction(db, stores, mode, run, current, timeout);
		return current() ? result : undefined;
	}
	private runTransaction<T>(
		db: IDBDatabase,
		stores: string[],
		mode: IDBTransactionMode,
		run: (tx: IDBTransaction) => Promise<T>,
		valid: () => boolean,
		timeout = 250
	): Promise<T | undefined> {
		return new Promise((resolve) => {
			let tx: IDBTransaction;
			try {
				tx = this.transaction(db, stores, mode);
			} catch {
				resolve(undefined);
				return;
			}
			let result: T | undefined;
			const timer = setTimeout(() => {
				try {
					tx.abort();
				} catch {}
				resolve(undefined);
			}, timeout);
			tx.oncomplete = () => {
				clearTimeout(timer);
				resolve(valid() ? result : undefined);
			};
			tx.onerror = tx.onabort = () => {
				clearTimeout(timer);
				resolve(undefined);
			};
			void run(tx)
				.then((value) => {
					if (valid()) result = value;
					else tx.abort();
				})
				.catch(() => {
					try {
						tx.abort();
					} catch {}
				});
		});
	}

	cancelReads = () => this.abortTransactions();
	clear = () => {
		this.configure(false);
		this.configure(true);
	};
	private abortTransactions() {
		for (const tx of this.transactions) {
			try {
				tx.abort();
			} catch {
				/* Already committed or aborted. */
			}
		}
		this.transactions.clear();
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		owners.delete(this);
		this.generation++;
		this.lifetime.abort();
		this.abortTransactions();
		this.releaseOpening?.();
		this.database?.close();
		this.database = undefined;
		this.opening = undefined;
		try {
			this.openingRequest?.transaction?.abort();
		} catch {
			/* Already settled. */
		}
		if (!this.openingRequest) this.releaseDisk();
	}
	private releaseDisk() {
		this.lease?.release();
		this.lease = undefined;
	}
	purge() {
		this.close();
		purgeWorkspaceReadStorage(this.scope);
	}
}
export function purgeWorkspaceReadStorage(scope: WorkspaceReadScope) {
	deletePersistentCache(workspaceReadDatabaseName(scope));
}

export const TEMPLATE_SOURCE_BYTES = 16 * 1024 * 1024;
export const TEMPLATE_DETAIL_BYTES = 4 * 1024 * 1024;
export const TEMPLATE_DETAIL_COUNT = 8;
export const TEMPLATE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
export type TemplateProse = { templateSourceFingerprint: string; blocks: SourceBlock[] };
type TemplateSourceRecord = {
	version: 1;
	key: string;
	savedAt: number;
	usedAt: number;
	prose: TemplateProse;
	bytes: number;
};
type TemplateDetailRecord = {
	version: 1;
	key: string;
	audience: TemplateAudience;
	savedAt: number;
	openedAt: number;
	usedAt: number;
	snapshot: TemplateContentSnapshot;
	bytes: number;
};
const freshTemplate = (v: Record<string, unknown>) =>
	v.version === 1 &&
	number(v.savedAt) &&
	(v.savedAt as number) <= Date.now() &&
	Date.now() - (v.savedAt as number) <= TEMPLATE_MAX_AGE;
const natural = (v: unknown) => number(v) && Number.isSafeInteger(v);
const sourceIdentity = (v: Record<string, unknown>) =>
	(v.templateSourceId === null || id(v.templateSourceId)) && text(v.templateSourceFingerprint, 256);
function validTemplateSource(v: unknown, companyId: string): v is TemplateSourceRecord {
	return (
		record(v) &&
		freshTemplate(v) &&
		text(v.key, 256) &&
		record(v.prose) &&
		v.prose.templateSourceFingerprint === v.key &&
		Array.isArray(v.prose.blocks) &&
		validTemplate(
			{ blockCount: v.prose.blocks.length, blocks: v.prose.blocks, items: [], itemCount: 0 },
			companyId
		) &&
		encodedBytes(v) <= TEMPLATE_SOURCE_BYTES &&
		natural(v.bytes) &&
		(v.bytes as number) >= encodedBytes(v)
	);
}
export function detailMatches(
	structure: StructureSnapshot,
	body: TemplateContentSnapshot
): boolean {
	if (
		!structure.ready ||
		!body.ready ||
		body.status !== 'present' ||
		structure.templateSourceId !== body.templateSourceId ||
		structure.templateSourceFingerprint !== body.templateSourceFingerprint
	)
		return false;
	const head = structure.items.find((h) => h._id === body.item._id);
	return (
		!!head &&
		head.companyId === body.item.companyId &&
		head._creationTime === body.item._creationTime &&
		head.contentRevision === body.item.contentRevision &&
		head.renderKey === body.item.renderKey
	);
}
export function templateDetailKey(
	audience: TemplateAudience,
	source: Pick<StructureSnapshot, 'templateSourceId' | 'templateSourceFingerprint'>,
	head: Pick<
		StructureSnapshot['items'][number],
		'_id' | 'companyId' | '_creationTime' | 'contentRevision' | 'renderKey'
	>
) {
	return JSON.stringify([head._id, head.contentRevision, source.templateSourceFingerprint]);
}
function validTemplateDetail(v: unknown, companyId: string): v is TemplateDetailRecord {
	if (
		!record(v) ||
		!freshTemplate(v) ||
		!['rep', 'buyer'].includes(v.audience as string) ||
		!record(v.snapshot)
	)
		return false;
	const s = v.snapshot;
	return (
		sourceIdentity(s) &&
		s.ready === true &&
		s.status === 'present' &&
		record(s.item) &&
		id(s.item.renderKey) &&
		s.item.audience === v.audience &&
		validTemplate({ blocks: [], blockCount: 0, items: [s.item], itemCount: 1 }, companyId) &&
		v.key ===
			templateDetailKey(
				v.audience as TemplateAudience,
				s as unknown as StructureSnapshot,
				s.item as unknown as StructureSnapshot['items'][number]
			) &&
		encodedBytes(v) <= TEMPLATE_DETAIL_BYTES &&
		natural(v.bytes) &&
		(v.bytes as number) >= encodedBytes(v)
	);
}
function visitCursor(
	store: IDBObjectStore,
	visit: (cursor: IDBCursorWithValue) => void
): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = store.openCursor();
		request.onerror = () => reject(request.error);
		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) {
				resolve();
				return;
			}
			visit(cursor);
			cursor.continue();
		};
	});
}
function idbValue<T = unknown>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

export const workspaceReadResources = {
	cancelReads: () => owners.forEach((owner) => owner.cancelReads()),
	clear: () => owners.forEach((owner) => owner.clear()),
	endSession: () => {
		for (const owner of [...owners]) owner.close();
	},
	captureMembershipRetirement: ({ userId, membershipId }: MembershipRetirement) => {
		const retiring = [...owners].filter(
			(owner) => owner.userId === userId && owner.scope.membershipId === membershipId
		);
		return () => retiring.forEach((owner) => owner.close());
	},
	forgetAccount: (userId: string) => {
		for (const owner of [...owners]) if (owner.userId === userId) owner.close();
	}
};
