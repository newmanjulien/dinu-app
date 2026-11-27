import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';
import { afterStartupPaint } from './startup-perf';

export type PersistentCacheOwner = Readonly<{ userId: string; membershipId: string }>;
export type PersistentCache = PersistentCacheOwner &
	Readonly<{ kind: 'contracts' | 'workspace'; databaseName: string }>;
export type PersistentCacheEntry = PersistentCache &
	Readonly<{ version: 1; lastUsed: number; deletionId: string | null }>;
/** A disposable address can be reclaimed even when its owner metadata is unusable. */
type RecoveryMarker = Readonly<{
	version: 1;
	databaseName: string;
	recovery: true;
	deletionId: string;
}>;
type RegistryRecord = PersistentCacheEntry | RecoveryMarker;
export type PersistentCacheLease = Readonly<{
	valid: () => boolean;
	touch: () => void;
	release: () => void;
}>;
type CleanupState =
	| 'waiting'
	| 'deleting'
	| 'blocked'
	| 'error'
	| 'registry-unavailable'
	| 'coordination-unavailable';
type CleanupStatus = Readonly<{
	databaseName: string;
	legacy: boolean;
	recovery: boolean;
	state: CleanupState;
}>;

const deployment = env.PUBLIC_CONVEX_URL ?? '';
const prefix = `dinu:cache-registry:v1:${encodeURIComponent(deployment)}:`;
const key = (databaseName: string) => `${prefix}${encodeURIComponent(databaseName)}`;
const lockName = (databaseName: string, kind: 'metadata' | 'access') =>
	`${key(databaseName)}:${kind}`;
const text = (value: unknown): value is string =>
	typeof value === 'string' && value.length > 0 && value.length <= 2048;
const useInterval = 60_000;
const preferred = new Map<PersistentCache['kind'], string>();
const clients = new Map<string, Set<() => void>>();
const deletions = new Map<string, Promise<void>>();
const statuses = new Map<string, CleanupStatus>();
let channel: BroadcastChannel | undefined;
let listening = false;
let pruningScheduled = false;
let pruneNotBefore = 0;
let discovering = false;

function locks(): LockManager | undefined {
	try {
		const manager = browser && typeof navigator !== 'undefined' ? navigator.locks : undefined;
		return typeof manager?.request === 'function' ? manager : undefined;
	} catch {
		return undefined;
	}
}
function stopClients(databaseName: string) {
	for (const stop of [...(clients.get(databaseName) ?? [])]) stop();
	for (const [kind, name] of preferred) if (name === databaseName) preferred.delete(kind);
}
function announce(databaseName: string) {
	stopClients(databaseName);
	try {
		channel?.postMessage(databaseName);
	} catch {
		/* Storage events provide the other signal. */
	}
}
function listen() {
	if (listening || !browser || typeof window === 'undefined') return;
	listening = true;
	try {
		channel = new BroadcastChannel(prefix);
		channel.onmessage = (event: MessageEvent<unknown>) => {
			if (text(event.data) && cacheKind(event.data)) stopClients(event.data);
		};
	} catch {
		/* No channel is needed for registry storage events. */
	}
	window.addEventListener('storage', (event) => {
		if (event.key !== null && !event.key.startsWith(prefix)) return;
		for (const name of [...clients.keys()]) {
			try {
				if (!read(name) || read(name)?.deletionId) stopClients(name);
			} catch {
				stopClients(name);
			}
		}
		schedulePruning(true);
	});
	window.addEventListener('pageshow', () => schedulePruning(true));
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') schedulePruning(true);
	});
}

function cacheKind(databaseName: string): PersistentCache['kind'] | undefined {
	if (databaseName.startsWith(`dinu:v9:${deployment}:`) && databaseName.endsWith(':snapshots'))
		return 'contracts';
	if (databaseName.startsWith(`dinu:workspace-read:v2:${deployment}:`)) return 'workspace';
}
function legacyName(databaseName: string) {
	// Discover only this deployment's disposable stores; names are never interpreted as identity.
	const match = /^(dinu:v\d+:|dinu:workspace-read:v\d+:)/.exec(databaseName);
	if (!match || !databaseName.slice(match[0].length).startsWith(`${deployment}:`)) return false;
	return match[0].startsWith('dinu:workspace-read:') || databaseName.endsWith(':snapshots');
}
function write(entry: RegistryRecord) {
	const raw = JSON.stringify(entry);
	if (raw.length > 8192) throw new Error('Cache registry record exceeds its metadata limit.');
	localStorage.setItem(key(entry.databaseName), raw);
}
function readRecord(databaseName: string): RegistryRecord | undefined {
	const raw = localStorage.getItem(key(databaseName));
	if (!raw || raw.length > 8192) return;
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		return;
	}
	if (
		value?.version === 1 &&
		value.databaseName === databaseName &&
		text(databaseName) &&
		legacyName(databaseName) &&
		value.recovery === true &&
		text(value.deletionId)
	)
		return { version: 1, databaseName, recovery: true, deletionId: value.deletionId };
	const kind = cacheKind(databaseName);
	if (
		!kind ||
		!value ||
		value.version !== 1 ||
		value.databaseName !== databaseName ||
		!text(value.userId) ||
		!text(value.membershipId) ||
		!text(value.databaseName) ||
		!Number.isFinite(value.lastUsed) ||
		value.lastUsed < 0 ||
		(value.deletionId !== null && !text(value.deletionId)) ||
		kind !== value.kind
	)
		return;
	return {
		version: 1,
		kind,
		databaseName: value.databaseName,
		userId: value.userId,
		membershipId: value.membershipId,
		lastUsed: value.lastUsed,
		deletionId: value.deletionId
	};
}
function read(databaseName: string): PersistentCacheEntry | undefined {
	const record = readRecord(databaseName);
	return record && 'kind' in record ? record : undefined;
}

function recoverMalformedRecords() {
	try {
		const names: string[] = [];
		for (let index = 0; index < localStorage.length; index++) {
			const storageKey = localStorage.key(index);
			if (!storageKey?.startsWith(prefix)) continue;
			try {
				const name = decodeURIComponent(storageKey.slice(prefix.length));
				if (key(name) === storageKey && text(name) && legacyName(name)) names.push(name);
			} catch {
				/* An invalid address does not authorize deleting a database. */
			}
		}
		for (const name of names) {
			const record = readRecord(name);
			if (!record || 'recovery' in record) deleteCache(name, true);
		}
	} catch {
		/* Optional registry access can fail; safe opportunities retry. */
	}
}

/** Disposable inventory only; these records never establish access. */
export function listPersistentCaches(): PersistentCacheEntry[] {
	if (!browser) return [];
	try {
		const entries: PersistentCacheEntry[] = [];
		for (let i = 0; i < localStorage.length; i++) {
			const storageKey = localStorage.key(i);
			if (!storageKey?.startsWith(prefix)) continue;
			try {
				const entry = read(decodeURIComponent(storageKey.slice(prefix.length)));
				if (entry) entries.push(entry);
			} catch {
				/* One malformed record cannot hide other scopes. */
			}
		}
		return entries;
	} catch {
		return [];
	}
}

/** Registration/marker/removal are serialized, independently of lifetime native-access locks. */
function metadata<T>(databaseName: string, run: () => T, signal?: AbortSignal): Promise<T> {
	return locks()!.request(lockName(databaseName, 'metadata'), { mode: 'exclusive', signal }, run);
}
function rememberUse(cache: PersistentCache) {
	const changed = preferred.get(cache.kind) !== cache.databaseName;
	preferred.set(cache.kind, cache.databaseName);
	schedulePruning(changed);
}
function register(cache: PersistentCache): boolean {
	const previous = read(cache.databaseName);
	if (!previous && localStorage.getItem(key(cache.databaseName)) !== null) return false;
	if (
		previous?.deletionId ||
		(previous &&
			(previous.userId !== cache.userId ||
				previous.membershipId !== cache.membershipId ||
				previous.kind !== cache.kind))
	)
		return false;
	const now = Date.now();
	if (!previous || previous.lastUsed > now || now - previous.lastUsed >= useInterval)
		write({
			version: 1,
			kind: cache.kind,
			databaseName: cache.databaseName,
			userId: cache.userId,
			membershipId: cache.membershipId,
			lastUsed: now,
			deletionId: null
		});
	rememberUse(cache);
	return true;
}

/** Optional disk access holds a shared lock until native opens/transactions have closed. */
export function acquirePersistentCache(
	cache: PersistentCache,
	close: () => void,
	signal: AbortSignal
): Promise<PersistentCacheLease | undefined> {
	if (
		!locks() ||
		signal.aborted ||
		!text(cache.userId) ||
		!text(cache.membershipId) ||
		!text(cache.databaseName) ||
		cacheKind(cache.databaseName) !== cache.kind
	)
		return Promise.resolve(undefined);
	listen();
	schedulePruning(true);
	return new Promise((resolve) => {
		const acquisition = new AbortController();
		let admitted = false;
		let stopped = false;
		let released = false;
		let releaseAccess!: () => void;
		const done = new Promise<void>((resolveDone) => {
			releaseAccess = resolveDone;
		});
		const release = () => {
			if (released) return;
			released = true;
			stopped = true;
			acquisition.abort();
			releaseAccess();
		};
		// Abandon a stalled acquisition without closing or poisoning the cache owner.
		const timer = setTimeout(() => {
			if (admitted || stopped) return;
			release();
			resolve(undefined);
		}, 250);
		const stop = () => {
			if (stopped) return;
			stopped = true;
			acquisition.abort();
			close();
			if (!admitted) release();
		};
		const group = clients.get(cache.databaseName) ?? new Set<() => void>();
		clients.set(cache.databaseName, group);
		group.add(stop);
		signal.addEventListener('abort', stop, { once: true });
		void Promise.resolve()
			.then(() =>
				locks()!.request(
					lockName(cache.databaseName, 'access'),
					{ mode: 'shared', signal: acquisition.signal },
					async () => {
						if (stopped) return;
						admitted = await metadata(
							cache.databaseName,
							() => register(cache),
							acquisition.signal
						);
						if (!admitted || stopped) {
							release();
							resolve(undefined);
							return;
						}
						let touchedAt = Date.now();
						clearTimeout(timer);
						resolve({
							valid: () => !stopped && !released,
							release,
							touch: () => {
								if (stopped || released) return;
								rememberUse(cache);
								const now = Date.now();
								if (now >= touchedAt && now - touchedAt < useInterval) return;
								touchedAt = now;
								void Promise.resolve()
									.then(() =>
										metadata(cache.databaseName, () => register(cache), acquisition.signal)
									)
									.then((valid) => {
										if (!valid) stop();
									})
									.catch(stop);
							}
						});
						await done;
					}
				)
			)
			.catch(() => {
				resolve(undefined);
			})
			.finally(() => {
				clearTimeout(timer);
				resolve(undefined);
				signal.removeEventListener('abort', stop);
				group.delete(stop);
				if (!group.size && clients.get(cache.databaseName) === group)
					clients.delete(cache.databaseName);
			});
	});
}

function prunePersistentCaches() {
	recoverMalformedRecords();
	const retained = new Set<PersistentCache['kind']>();
	const entries = listPersistentCaches().sort(
		(a, b) =>
			Number(preferred.get(b.kind) === b.databaseName) -
				Number(preferred.get(a.kind) === a.databaseName) ||
			b.lastUsed - a.lastUsed ||
			a.databaseName.localeCompare(b.databaseName)
	);
	for (const entry of entries) {
		if (!entry.deletionId && !retained.has(entry.kind)) {
			retained.add(entry.kind);
			continue;
		}
		deletePersistentCache(entry.databaseName);
	}
	// Marker/native failures are retried on a safe event even if their scope now sorts first.
	for (const outcome of [...statuses.values()])
		if (!outcome.legacy && !deletions.has(outcome.databaseName))
			deleteCache(outcome.databaseName, outcome.recovery);
	void discoverLegacyCaches();
}
function schedulePruning(force = false) {
	if (
		!browser ||
		typeof requestAnimationFrame === 'undefined' ||
		pruningScheduled ||
		(!force && Date.now() < pruneNotBefore)
	)
		return;
	pruningScheduled = true;
	afterStartupPaint(() => {
		pruningScheduled = false;
		pruneNotBefore = Date.now() + useInterval;
		prunePersistentCaches();
	});
}

/** Capture targets now, before publishing a replacement account; cleanup never gates rendering. */
export function retirePersistentCaches(current?: PersistentCacheOwner) {
	purgePersistentCaches(
		(entry) =>
			!current || entry.userId !== current.userId || entry.membershipId !== current.membershipId
	);
}
export function purgePersistentCaches(matches: (entry: PersistentCacheEntry) => boolean) {
	listen();
	for (const entry of listPersistentCaches())
		if (matches(entry)) deletePersistentCache(entry.databaseName);
	void discoverLegacyCaches();
	schedulePruning(true);
}

/** Pending outcomes only; successful cleanup leaves no completion-history cache. */
export function persistentCacheCleanupStatus(): readonly CleanupStatus[] {
	return [...statuses.values()];
}
function status(databaseName: string, legacy: boolean, state: CleanupState, recovery = false) {
	statuses.set(databaseName, { databaseName, legacy, recovery, state });
}
function nativeDeletion(databaseName: string, legacy: boolean, recovery = false): Promise<void> {
	return new Promise((resolve, reject) => {
		try {
			status(databaseName, legacy, 'deleting', recovery);
			const request = indexedDB.deleteDatabase(databaseName);
			request.onblocked = () => {
				status(databaseName, legacy, 'blocked', recovery);
				announce(databaseName);
			};
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve();
		} catch (error) {
			reject(error);
		}
	});
}

/** One request per name. A blocked native request retains both its lock and inventory. */
export function deletePersistentCache(databaseName: string) {
	deleteCache(databaseName);
}
function deleteCache(databaseName: string, onlyMalformed = false) {
	if (!browser || !text(databaseName) || !legacyName(databaseName) || deletions.has(databaseName))
		return;
	listen();
	if (!onlyMalformed) announce(databaseName);
	if (!locks()) {
		status(databaseName, false, 'coordination-unavailable', onlyMalformed);
		return;
	}
	status(databaseName, false, 'waiting', onlyMalformed);
	const work = (async () => {
		let entry: RegistryRecord | undefined;
		try {
			entry = await metadata(databaseName, () => {
				const previous = readRecord(databaseName);
				if (previous?.deletionId) return previous;
				// A different tab may have reclaimed corruption and registered a fresh owner.
				if (onlyMalformed && previous) return;
				if (!previous && localStorage.getItem(key(databaseName)) === null) return;
				const marked: RegistryRecord = previous
					? { ...previous, deletionId: crypto.randomUUID() }
					: { version: 1, databaseName, recovery: true, deletionId: crypto.randomUUID() };
				write(marked);
				return marked;
			});
		} catch {
			status(databaseName, false, 'registry-unavailable', onlyMalformed);
			return;
		}
		if (!entry?.deletionId) {
			statuses.delete(databaseName);
			return;
		}
		announce(databaseName);
		await locks()!.request(lockName(databaseName, 'access'), { mode: 'exclusive' }, async () => {
			// Another tab may have completed the same marker while this access lock waited.
			const pending = await metadata(
				databaseName,
				() => readRecord(databaseName)?.deletionId === entry!.deletionId
			);
			if (!pending) {
				statuses.delete(databaseName);
				return;
			}
			await nativeDeletion(databaseName, false, onlyMalformed);
			try {
				await metadata(databaseName, () => {
					if (readRecord(databaseName)?.deletionId === entry!.deletionId)
						localStorage.removeItem(key(databaseName));
				});
				statuses.delete(databaseName);
			} catch {
				status(databaseName, false, 'registry-unavailable', onlyMalformed);
			}
		});
	})();
	deletions.set(databaseName, work);
	void work
		.catch(() => status(databaseName, false, 'error', onlyMalformed))
		.finally(() => deletions.delete(databaseName));
}

/** Enumeration has no ownership inference and never bypasses a registered deletion marker. */
async function discoverLegacyCaches() {
	if (
		!browser ||
		discovering ||
		!locks() ||
		typeof indexedDB === 'undefined' ||
		!indexedDB.databases
	)
		return;
	discovering = true;
	try {
		for (const { name } of await indexedDB.databases()) {
			if (!name || !legacyName(name) || deletions.has(name)) continue;
			// Malformed inventory uses coordinated recovery, never an unmarked legacy delete.
			if (localStorage.getItem(key(name)) !== null) {
				const record = readRecord(name);
				if (!record || 'recovery' in record) deleteCache(name, true);
				continue;
			}
			status(name, true, 'waiting');
			const work = locks()!.request(lockName(name, 'access'), { mode: 'exclusive' }, async () => {
				const unregistered = await metadata(name, () => localStorage.getItem(key(name)) === null);
				if (unregistered) {
					announce(name);
					await nativeDeletion(name, true);
				}
				statuses.delete(name);
			});
			deletions.set(name, work);
			void work.catch(() => status(name, true, 'error')).finally(() => deletions.delete(name));
		}
	} catch {
		/* Enumeration/registry access is best effort; future safe opportunities retry it. */
	} finally {
		discovering = false;
	}
}
