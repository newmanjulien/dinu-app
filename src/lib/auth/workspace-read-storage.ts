import type { SourceBlock } from '$lib/document/model';
import type { TemplateAudience } from '$lib/playbook/model';
import type { StructureSnapshot, TemplateContentSnapshot } from '$lib/playbook/structure';
import { validTemplate } from '$lib/contract/persisted-values';
import { immutable } from '$lib/immutable';
import { env } from '$env/dynamic/public';
import type { FunctionReturnType } from 'convex/server';
import type { api } from '../../convex/_generated/api';

export type WorkspaceReadScope = Readonly<{
	profileId: string;
	membershipId: string;
	companyId: string;
}>;
export type WorkspaceReadRows = {
	contracts: FunctionReturnType<typeof api.contracts.browse>['page'];
	buyerLinks: FunctionReturnType<typeof api.buyerLinks.browse>['page'];
	colleagues: FunctionReturnType<typeof api.profiles.colleagues>['page'];
	invitations: FunctionReturnType<typeof api.companyInvitations.list>['page'];
};
export type WorkspaceReadKey = keyof WorkspaceReadRows;
export type WorkspaceDirectoryKey = 'contracts' | 'buyerLinks';
export type WorkspaceDirectory<K extends WorkspaceDirectoryKey> = Readonly<{
	savedAt: number;
	rows: Readonly<WorkspaceReadRows[K]>;
}>;
export const WORKSPACE_READ_PAGE_SIZES = {
	contracts: 24,
	buyerLinks: 10,
	colleagues: 50,
	invitations: 50
} as const;
export const WORKSPACE_READ_MAX_BYTES = 128 * 1024;
export const WORKSPACE_READ_TOTAL_BYTES = 4 * WORKSPACE_READ_MAX_BYTES;
export const WORKSPACE_READ_MAX_AGE = 24 * 60 * 60 * 1000;
export type WorkspaceReadSnapshot<K extends WorkspaceReadKey> = Readonly<{
	version: 1;
	key: K;
	complete: true;
	savedAt: number;
	hasMore: boolean;
	rows: Readonly<WorkspaceReadRows[K]>;
}>;
export function workspaceReadDatabaseName(scope: WorkspaceReadScope) {
	return `dinu:workspace-read:v1:${env.PUBLIC_CONVEX_URL ?? ''}:${scope.profileId}:${scope.membershipId}:${scope.companyId}`;
}
const record = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit = 256): value is string =>
	typeof value === 'string' && value.length <= limit;
const id = (value: unknown) => text(value, 256) && value.length > 0;
const number = (value: unknown) =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;
const avatar = (value: unknown) => value === null || text(value, 4096);
function validRow(key: WorkspaceReadKey, value: unknown): boolean {
	if (!record(value)) return false;
	switch (key) {
		case 'contracts': {
			const link = value.hubspot;
			return (
				id(value._id) &&
				number(value._creationTime) &&
				text(value.title, 200) &&
				number(value.savedAt) &&
				typeof value.hasUnreadComment === 'boolean' &&
				record(value.creator) &&
				text(value.creator.name, 200) &&
				avatar(value.creator.avatarUrl) &&
				(value.workBlock === undefined ||
					value.workBlock === null ||
					value.workBlock === 'association-required' ||
					value.workBlock === 'deal-unavailable') &&
				(link === undefined ||
					(record(link) &&
						id(link.connectionId) &&
						text(link.accountId) &&
						text(link.dealId) &&
						number(link.generation) &&
						(link.availability === 'available' || link.availability === 'unavailable')))
			);
		}
		case 'buyerLinks':
			return (
				id(value.id) &&
				id(value.contractId) &&
				text(value.token, 512) &&
				text(value.title, 200) &&
				number(value.createdAt) &&
				typeof value.hasUnreadComment === 'boolean'
			);
		case 'colleagues':
			return (
				id(value.id) &&
				id(value.membershipId) &&
				text(value.name, 200) &&
				text(value.email, 254) &&
				avatar(value.avatarUrl) &&
				(value.role === 'admin' || value.role === 'rep') &&
				typeof value.isOwner === 'boolean'
			);
		case 'invitations':
			return (
				id(value.id) &&
				text(value.email, 254) &&
				number(value.createdAt) &&
				number(value.expiresAt) &&
				['sending', 'sent', 'failed'].includes(value.deliveryStatus as string)
			);
	}
}
/** Copy only the named server projection; never retain extra fields from disk or mutable callers. */
export function copyWorkspaceReadRows<K extends WorkspaceReadKey>(
	key: K,
	rows: unknown,
	directory = false
): WorkspaceReadRows[K] | undefined {
	if (
		!Array.isArray(rows) ||
		(!directory && rows.length > WORKSPACE_READ_PAGE_SIZES[key]) ||
		![...rows].every((row) => validRow(key, row))
	)
		return;
	const identities = rows.map((row) =>
		key === 'contracts' ? row._id : key === 'colleagues' ? row.membershipId : row.id
	);
	if (new Set(identities).size !== rows.length) return;
	const copied = rows.map((row) => {
		switch (key) {
			case 'contracts':
				return Object.freeze({
					_id: row._id,
					_creationTime: row._creationTime,
					title: row.title,
					savedAt: row.savedAt,
					hasUnreadComment: row.hasUnreadComment,
					...(row.workBlock !== undefined ? { workBlock: row.workBlock } : {}),
					...(row.hubspot
						? {
								hubspot: Object.freeze({
									connectionId: row.hubspot.connectionId,
									accountId: row.hubspot.accountId,
									dealId: row.hubspot.dealId,
									generation: row.hubspot.generation,
									availability: row.hubspot.availability
								})
							}
						: {}),
					creator: Object.freeze({ name: row.creator.name, avatarUrl: row.creator.avatarUrl })
				});
			case 'buyerLinks':
				return Object.freeze({
					id: row.id,
					contractId: row.contractId,
					token: row.token,
					title: row.title,
					createdAt: row.createdAt,
					hasUnreadComment: row.hasUnreadComment
				});
			case 'colleagues':
				return Object.freeze({
					id: row.id,
					membershipId: row.membershipId,
					name: row.name,
					email: row.email,
					avatarUrl: row.avatarUrl,
					role: row.role,
					isOwner: row.isOwner
				});
			case 'invitations':
				return Object.freeze({
					id: row.id,
					email: row.email,
					createdAt: row.createdAt,
					expiresAt: row.expiresAt,
					deliveryStatus: row.deliveryStatus
				});
		}
	});
	// Count bounded field bytes without building a serialized payload on route arrival.
	if (!directory && encodedBytes(copied) > WORKSPACE_READ_MAX_BYTES - 256) return;
	return Object.freeze(copied) as unknown as WorkspaceReadRows[K];
}
function decode<K extends WorkspaceReadKey>(
	key: K,
	value: unknown
): WorkspaceReadSnapshot<K> | undefined {
	if (
		!record(value) ||
		value.version !== 1 ||
		value.key !== key ||
		value.complete !== true ||
		!number(value.savedAt) ||
		typeof value.hasMore !== 'boolean'
	)
		return;
	const savedAt = value.savedAt as number;
	if (savedAt > Date.now() || Date.now() - savedAt > WORKSPACE_READ_MAX_AGE) return;
	const rows = copyWorkspaceReadRows(key, value.rows);
	if (!rows) return;
	const result = Object.freeze({
		version: 1 as const,
		key,
		complete: true as const,
		savedAt,
		hasMore: value.hasMore,
		rows
	});
	return encodedBytes(result) <= WORKSPACE_READ_MAX_BYTES ? result : undefined;
}
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

const workspaceReadStores = [
	'projections',
	'contractDirectory',
	'buyerLinkDirectory',
	'directoryMetadata',
	'templateSources',
	'templateViews',
	'templateDetails',
	'templateMetadata'
];

/** Optional storage shared by the retained workspace and both template audiences. */
export class WorkspaceReadStorage {
	private database?: Promise<IDBDatabase | undefined>;
	private closed = false;
	private available = true;
	private generation = 0;
	private resetReady = true;
	private resetBarrier = Promise.resolve();
	private queue = Promise.resolve();
	private transactions = new Set<IDBTransaction>();
	constructor(readonly scope: WorkspaceReadScope) {}
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
		if (this.database) return this.database;
		const attempt = new Promise<IDBDatabase | undefined>((resolve) => {
			let settled = false;
			const finish = (db?: IDBDatabase) => {
				if (settled || this.closed) {
					db?.close();
					if (settled) return;
				}
				settled = true;
				resolve(this.closed ? undefined : db);
			};
			try {
				const request = indexedDB.open(workspaceReadDatabaseName(this.scope), 3);
				request.onupgradeneeded = () => {
					for (const name of workspaceReadStores)
						if (!request.result.objectStoreNames.contains(name))
							request.result.createObjectStore(name, { keyPath: 'key' });
				};
				// A blocked upgrade can succeed after another tab closes its old connection.
				request.onerror = () => finish();
				request.onsuccess = () => {
					request.result.onversionchange = () => this.close();
					finish(request.result);
				};
			} catch {
				finish();
			}
		});
		this.database = attempt;
		void attempt.then((db) => {
			if (!db && this.database === attempt) this.database = undefined;
		});
		return attempt;
	}
	async read<K extends WorkspaceReadKey>(key: K): Promise<WorkspaceReadSnapshot<K> | undefined> {
		return this.storageTransaction(
			['projections'],
			'readonly',
			async (tx) => {
				const value = await idbValue(tx.objectStore('projections').get(key));
				return decode(key, value);
			},
			this.generation,
			() => true,
			key === 'contracts' || key === 'buyerLinks' ? 30_000 : 250
		);
	}
	async readDirectory<K extends WorkspaceDirectoryKey>(
		key: K
	): Promise<WorkspaceDirectory<K> | undefined> {
		const storeName = key === 'contracts' ? 'contractDirectory' : 'buyerLinkDirectory';
		return this.storageTransaction(
			[storeName, 'directoryMetadata'],
			'readonly',
			async (tx) => {
				const meta: unknown = await idbValue(tx.objectStore('directoryMetadata').get(key));
				if (!record(meta) || meta.complete !== true || !number(meta.savedAt)) return;
				const savedAt = meta.savedAt as number;
				if (savedAt > Date.now()) return;
				const stored: unknown = await idbValue(tx.objectStore(storeName).getAll());
				if (
					!Array.isArray(stored) ||
					stored.length !== meta.count ||
					stored.some(
						(row) =>
							!record(row) ||
							!Number.isSafeInteger(row.position) ||
							(row.position as number) < 0 ||
							(row.position as number) >= stored.length
					)
				)
					return;
				if (new Set(stored.map((row) => row.position)).size !== stored.length) return;
				stored.sort((a, b) => a.position - b.position);
				const rows = copyWorkspaceReadRows(key, stored, true);
				return rows ? { savedAt, rows } : undefined;
			},
			this.generation,
			() => true,
			30_000
		);
	}
	writeDirectory<K extends WorkspaceDirectoryKey>(
		key: K,
		rows: WorkspaceReadRows[K],
		valid: () => boolean
	) {
		const copied = copyWorkspaceReadRows(key, rows, true);
		if (!copied) return;
		const storeName = key === 'contracts' ? 'contractDirectory' : 'buyerLinkDirectory';
		this.enqueue(async (generation) => {
			if (!valid()) return;
			await this.storageTransaction(
				[storeName, 'directoryMetadata'],
				'readwrite',
				async (tx) => {
					const store = tx.objectStore(storeName);
					store.clear();
					for (const [position, row] of copied.entries())
						store.put({ ...row, key: '_id' in row ? row._id : row.id, position });
					tx.objectStore('directoryMetadata').put({
						key,
						complete: true,
						savedAt: Date.now(),
						count: copied.length
					});
				},
				generation,
				valid,
				30_000
			);
		});
	}
	clearDirectory(key: WorkspaceDirectoryKey) {
		const storeName = key === 'contracts' ? 'contractDirectory' : 'buyerLinkDirectory';
		this.enqueue(async (generation) => {
			await this.storageTransaction(
				[storeName, 'directoryMetadata'],
				'readwrite',
				async (tx) => {
					tx.objectStore(storeName).clear();
					tx.objectStore('directoryMetadata').delete(key);
				},
				generation
			);
		});
	}
	write<K extends WorkspaceReadKey>(
		key: K,
		value: WorkspaceReadSnapshot<K> | undefined,
		valid: () => boolean
	) {
		this.enqueue(async (generation) => {
			if (!valid()) return;
			// Disk work is deferred by the owner. Oversize replaces only this key with absence.
			const accepted = value && encodedBytes(value) <= WORKSPACE_READ_MAX_BYTES ? value : undefined;
			await this.storageTransaction(
				['projections'],
				'readwrite',
				async (tx) => {
					const store = tx.objectStore('projections');
					if (accepted) store.put(accepted);
					else store.delete(key);
				},
				generation,
				valid
			);
		});
	}
	/** Targeted coherent reads. No disk observation certifies authoring. */
	async readTemplateView(audience: TemplateAudience): Promise<TemplateViewPair | undefined> {
		return this.storageTransaction(['templateViews', 'templateSources'], 'readonly', async (tx) => {
			const view: unknown = await idbValue(tx.objectStore('templateViews').get(audience));
			if (!validTemplateView(view, audience, this.scope.companyId)) return;
			const source: unknown = await idbValue(
				tx.objectStore('templateSources').get(view.fingerprint)
			);
			if (!validTemplateSource(source, this.scope.companyId) || source.key !== view.fingerprint)
				return;
			if (source.bytes + view.bytes > TEMPLATE_VIEW_BYTES) return;
			return { source: source.prose, structure: immutable(view.structure) };
		});
	}
	async readTemplateSource(): Promise<TemplateProse | undefined> {
		return this.storageTransaction(
			['templateSources', 'templateMetadata'],
			'readonly',
			async (tx) => {
				const metadata = await templateMetadata(tx);
				const latest = metadata.views.sort((a, b) => b.savedAt - a.savedAt)[0];
				if (!latest) return;
				const value: unknown = await idbValue(
					tx.objectStore('templateSources').get(latest.fingerprint)
				);
				return validTemplateSource(value, this.scope.companyId) ? value.prose : undefined;
			}
		);
	}
	writeTemplateView(
		audience: TemplateAudience,
		prose: TemplateProse,
		structure: StructureSnapshot,
		valid: () => boolean
	) {
		this.enqueue(async (generation) => {
			if (
				!valid() ||
				!structure.ready ||
				prose.templateSourceFingerprint !== structure.templateSourceFingerprint
			)
				return;
			const savedAt = Date.now();
			const source = {
				version: 1 as const,
				key: prose.templateSourceFingerprint,
				savedAt,
				prose,
				bytes: 0
			};
			const view = {
				version: 1 as const,
				key: audience,
				savedAt,
				fingerprint: source.key,
				structure,
				bytes: 0
			};
			let sourceBytes = templateSourceSizes.get(prose);
			if (sourceBytes === undefined) {
				sourceBytes = encodedBytes(source) + 64;
				templateSourceSizes.set(prose, sourceBytes);
			}
			source.bytes = sourceBytes;
			view.bytes = encodedBytes(view) + 64;
			// An oversized candidate never evicts the other useful audience.
			if (source.bytes + view.bytes > TEMPLATE_VIEW_BYTES) return;
			await this.storageTransaction(
				['templateSources', 'templateViews', 'templateDetails', 'templateMetadata'],
				'readwrite',
				async (tx) => {
					const metadata = await templateMetadata(tx);
					if (!valid()) {
						tx.abort();
						return;
					}
					const entry: TemplateViewMetadata = {
						key: 'view:' + audience,
						audience,
						fingerprint: source.key,
						bytes: view.bytes,
						sourceBytes: source.bytes,
						sourceSavedAt:
							metadata.views.find((v) => v.fingerprint === source.key)?.sourceSavedAt ?? savedAt,
						sourceId: structure.templateSourceId,
						authoringGeneration: structure.authoringGeneration,
						savedAt
					};
					let next = [...metadata.views.filter((v) => v.audience !== audience), entry];
					const total = () =>
						next.reduce((n, v) => n + v.bytes, 0) +
						[...new Set(next.map((v) => v.fingerprint))].reduce(
							(n, key) => n + next.find((v) => v.fingerprint === key)!.sourceBytes,
							0
						);
					if (total() > TEMPLATE_VIEW_BYTES) next = [entry];
					const refs = new Set(next.map((v) => v.fingerprint));
					const sources = tx.objectStore('templateSources'),
						views = tx.objectStore('templateViews'),
						details = tx.objectStore('templateDetails'),
						meta = tx.objectStore('templateMetadata');
					for (const old of metadata.views) {
						if (!next.some((v) => v.audience === old.audience)) {
							views.delete(old.audience);
							meta.delete(old.key);
						}
						if (!refs.has(old.fingerprint)) sources.delete(old.fingerprint);
					}
					if (Date.now() - entry.sourceSavedAt >= TEMPLATE_MAX_AGE) entry.sourceSavedAt = savedAt;
					views.put(view);
					meta.put(entry);
					if (
						!metadata.views.some(
							(v) => v.fingerprint === source.key && Date.now() - v.sourceSavedAt < TEMPLATE_MAX_AGE
						)
					)
						sources.put(source);
					const allowed = new Set(
						structure.items.map((head) => templateDetailKey(audience, structure, head))
					);
					for (const body of metadata.details)
						if (
							(body.audience === audience && !allowed.has(body.bodyKey)) ||
							!next.some((v) => v.audience === body.audience)
						) {
							details.delete(body.bodyKey);
							meta.delete(body.key);
						}
				},
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
		if (!structure.ready || !head) return;
		return this.storageTransaction(['templateDetails'], 'readonly', async (tx) => {
			const key = templateDetailKey(audience, structure, head);
			const body: unknown = await idbValue(tx.objectStore('templateDetails').get(key));
			return validTemplateDetail(body, this.scope.companyId) &&
				body.key === key &&
				detailMatches(structure, body.snapshot)
				? immutable(body.snapshot)
				: undefined;
		});
	}
	forgetTemplateDetail(audience: TemplateAudience, structure: StructureSnapshot, itemId: string) {
		const head = structure.items.find((item) => item._id === itemId);
		if (!head) return;
		const key = templateDetailKey(audience, structure, head);
		this.enqueue((generation) =>
			this.storageTransaction(
				['templateDetails', 'templateMetadata'],
				'readwrite',
				async (tx) => {
					tx.objectStore('templateDetails').delete(key);
					tx.objectStore('templateMetadata').delete('detail:' + key);
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
			const body = {
				version: 1 as const,
				key: templateDetailKey(audience, structure, snapshot.item),
				audience,
				savedAt: Date.now(),
				openedAt,
				snapshot,
				bytes: 0
			};
			body.bytes = encodedBytes(body) + 64;
			if (body.bytes > TEMPLATE_DETAIL_BYTES) return;
			await this.storageTransaction(
				['templateDetails', 'templateMetadata'],
				'readwrite',
				async (tx) => {
					const metadata = await templateMetadata(tx),
						store = tx.objectStore('templateDetails'),
						meta = tx.objectStore('templateMetadata');
					if (
						!valid() ||
						!metadata.views.some(
							(v) =>
								v.audience === audience &&
								v.fingerprint === structure.templateSourceFingerprint &&
								v.sourceId === structure.templateSourceId &&
								v.authoringGeneration === structure.authoringGeneration
						)
					)
						return;
					const entry: TemplateDetailMetadata = {
						key: 'detail:' + body.key,
						bodyKey: body.key,
						audience,
						bytes: body.bytes,
						savedAt: body.savedAt,
						openedAt
					};
					const next = [...metadata.details.filter((v) => v.key !== entry.key), entry].sort(
						(a, b) => b.openedAt - a.openedAt
					);
					let bytes = 0;
					const keep = new Set(
						next
							.filter(
								(v, i) => i < TEMPLATE_DETAIL_COUNT && (bytes += v.bytes) <= TEMPLATE_DETAIL_BYTES
							)
							.map((v) => v.key)
					);
					for (const old of metadata.details)
						if (!keep.has(old.key)) {
							store.delete(old.bodyKey);
							meta.delete(old.key);
						}
					if (keep.has(entry.key)) {
						store.put(body);
						meta.put(entry);
					}
				},
				generation,
				valid
			);
		});
	}
	clearTemplates(audience?: TemplateAudience) {
		this.enqueue((generation) =>
			this.storageTransaction(
				['templateSources', 'templateViews', 'templateDetails', 'templateMetadata'],
				'readwrite',
				async (tx) => {
					if (!audience) {
						for (const store of [
							'templateSources',
							'templateViews',
							'templateDetails',
							'templateMetadata'
						])
							tx.objectStore(store).clear();
						return;
					}
					const metadata = await templateMetadata(tx),
						meta = tx.objectStore('templateMetadata');
					tx.objectStore('templateViews').delete(audience);
					meta.delete('view:' + audience);
					for (const body of metadata.details)
						if (body.audience === audience) {
							tx.objectStore('templateDetails').delete(body.bodyKey);
							meta.delete(body.key);
						}
					const refs = new Set(
						metadata.views.filter((v) => v.audience !== audience).map((v) => v.fingerprint)
					);
					for (const view of metadata.views)
						if (!refs.has(view.fingerprint))
							tx.objectStore('templateSources').delete(view.fingerprint);
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
		this.generation++;
		this.abortTransactions();
		void this.database?.then((db) => db?.close());
	}
	purge() {
		this.close();
		purgeWorkspaceReadStorage(this.scope);
	}
}
export function purgeWorkspaceReadStorage(scope: WorkspaceReadScope) {
	try {
		if (typeof indexedDB !== 'undefined')
			indexedDB.deleteDatabase(workspaceReadDatabaseName(scope));
	} catch {
		/* Optional cache. */
	}
}

export const TEMPLATE_VIEW_BYTES = 16 * 1024 * 1024;
export const TEMPLATE_DETAIL_BYTES = 4 * 1024 * 1024;
export const TEMPLATE_DETAIL_COUNT = 8;
export const TEMPLATE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
export type TemplateProse = { templateSourceFingerprint: string; blocks: SourceBlock[] };
export type TemplateViewPair = { source: TemplateProse; structure: StructureSnapshot };
type TemplateSourceRecord = {
	version: 1;
	key: string;
	savedAt: number;
	prose: TemplateProse;
	bytes: number;
};
type TemplateViewRecord = {
	version: 1;
	key: TemplateAudience;
	savedAt: number;
	fingerprint: string;
	structure: StructureSnapshot;
	bytes: number;
};
type TemplateDetailRecord = {
	version: 1;
	key: string;
	audience: TemplateAudience;
	savedAt: number;
	openedAt: number;
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
function target(v: unknown): boolean {
	if (!record(v)) return false;
	if (v.kind === 'boundary') return id(v.afterBlockKey);
	const point = (p: unknown) => record(p) && id(p.sourceKey) && natural(p.offset);
	return v.kind === 'text' && record(v.range) && point(v.range.start) && point(v.range.end);
}
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
		encodedBytes(v) <= TEMPLATE_VIEW_BYTES &&
		natural(v.bytes) &&
		(v.bytes as number) >= encodedBytes(v)
	);
}
function validTemplateView(
	v: unknown,
	audience: TemplateAudience,
	companyId: string
): v is TemplateViewRecord {
	if (
		!record(v) ||
		!freshTemplate(v) ||
		v.key !== audience ||
		!['rep', 'buyer'].includes(audience) ||
		!record(v.structure)
	)
		return false;
	const s = v.structure;
	if (
		!sourceIdentity(s) ||
		v.fingerprint !== s.templateSourceFingerprint ||
		s.ready !== true ||
		!natural(s.authoringGeneration) ||
		!natural(s.structuralGeneration) ||
		!Array.isArray(s.items) ||
		s.items.length > 4000
	)
		return false;
	const ids = new Set();
	for (const item of s.items) {
		if (
			!record(item) ||
			!id(item._id) ||
			ids.has(item._id) ||
			item.companyId !== companyId ||
			!number(item._creationTime) ||
			!natural(item.contentRevision) ||
			!id(item.renderKey) ||
			item.audience !== audience ||
			!record(item.trigger) ||
			!id(item.trigger.id) ||
			!target(item.trigger.target) ||
			!Array.isArray(item.concessions) ||
			item.concessions.length > 8192
		)
			return false;
		ids.add(item._id);
		for (const c of item.concessions)
			if (
				!record(c) ||
				!id(c.id) ||
				!Array.isArray(c.changes) ||
				c.changes.length > 2 ||
				!c.changes.every(
					(change) =>
						record(change) &&
						target(change.target) &&
						natural(change.paragraphBreaks) &&
						typeof change.meaningful === 'boolean'
				)
			)
				return false;
	}
	return (
		encodedBytes(v) <= TEMPLATE_VIEW_BYTES &&
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
	return JSON.stringify([
		audience,
		source.templateSourceId,
		source.templateSourceFingerprint,
		head._id,
		head.companyId,
		head._creationTime,
		head.contentRevision,
		head.renderKey
	]);
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
function idbValue<T = unknown>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

const templateSourceSizes = new WeakMap<TemplateProse, number>();
type TemplateViewMetadata = {
	key: string;
	audience: TemplateAudience;
	fingerprint: string;
	bytes: number;
	sourceBytes: number;
	sourceSavedAt: number;
	sourceId: StructureSnapshot['templateSourceId'];
	authoringGeneration: number;
	savedAt: number;
};
type TemplateDetailMetadata = {
	key: string;
	bodyKey: string;
	audience: TemplateAudience;
	bytes: number;
	savedAt: number;
	openedAt: number;
};
async function templateMetadata(
	tx: IDBTransaction
): Promise<{ views: TemplateViewMetadata[]; details: TemplateDetailMetadata[] }> {
	const values: unknown[] = await idbValue(tx.objectStore('templateMetadata').getAll());
	if (values.length > 10) throw new Error('Invalid template budget metadata');
	const views: TemplateViewMetadata[] = [],
		details: TemplateDetailMetadata[] = [];
	for (const v of values) {
		if (
			!record(v) ||
			!text(v.key, 4096) ||
			!['rep', 'buyer'].includes(v.audience as string) ||
			!natural(v.bytes) ||
			!number(v.savedAt)
		)
			throw new Error('Invalid template metadata');
		if (
			v.key === 'view:' + v.audience &&
			text(v.fingerprint, 256) &&
			natural(v.sourceBytes) &&
			number(v.sourceSavedAt) &&
			(v.sourceId === null || id(v.sourceId)) &&
			natural(v.authoringGeneration) &&
			(v.sourceBytes as number) + (v.bytes as number) <= TEMPLATE_VIEW_BYTES
		)
			views.push(v as TemplateViewMetadata);
		else if (
			v.key === 'detail:' + v.bodyKey &&
			text(v.bodyKey, 4096) &&
			number(v.openedAt) &&
			(v.bytes as number) <= TEMPLATE_DETAIL_BYTES
		)
			details.push(v as TemplateDetailMetadata);
		else throw new Error('Invalid template metadata');
	}
	if (views.length > 2 || details.length > 8) throw new Error('Invalid template budget');
	return { views, details };
}
