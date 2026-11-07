import { browser } from '$app/environment';
import { preloadCode } from '$app/navigation';
import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
import { recordColdStart } from '$lib/document/runtime/render-perf';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import {
	clearConfirmedCache,
	createCacheScope,
	RecentOpenings,
	type CacheScope
} from './browser-storage';
import {
	olderContractState,
	type ContractSnapshotResult,
	type ContractState,
	type ReadyContract,
	type TemplateContent
} from './saved';
import type { SnapshotEntry, SnapshotMetadata } from './snapshot-storage';
import {
	SNAPSHOT_BYTES,
	SNAPSHOT_ENTRIES,
	SnapshotStorage,
	validSnapshot,
	validTemplate
} from './snapshot-storage';

import { queryOnce, type SnapshotClient } from '$lib/query-once';
export type { SnapshotClient } from '$lib/query-once';
type VersionFlight = { result: Promise<TemplateContent>; attempt: ReadAttempt; consumers: number };

type Entry = SnapshotEntry & { contractJson: string };
type Flight = {
	result: Promise<ContractSnapshotResult>;
	attempt: ReadAttempt;
	background: boolean;
};
const MAX_ENTRIES = SNAPSHOT_ENTRIES;
const MAX_BYTES = SNAPSHOT_BYTES;
const BACKGROUND_CONCURRENCY = 2;

/** Browser-only, membership-scoped snapshots. Mutable state is refreshed on every open. */
class ContractSnapshotCache {
	private disk: SnapshotStorage;
	private get membershipId() {
		return this.scope.membershipId;
	}
	private client: SnapshotClient | undefined;
	private versionFlights = new Map<string, VersionFlight>();
	private deleted = new Set<string>();
	private entries = new Map<string, Entry>();
	private versions = new Map<
		string,
		{ snapshot: ReadyContract['snapshot']; bytes: number; references: number }
	>();
	private flights = new Map<string, Flight>();
	private queued = new Set<string>();
	private bytes = 0;
	private backgroundAllowed = false;
	private lifetime = new AbortController();
	private code: Promise<void> | undefined;
	private listeners = new Set<(data: ReadyContract) => void>();
	private evictions = new Set<(id: string) => void>();
	private failures = new Set<(id: string) => void>();
	private visibility = () => this.pump();
	constructor(
		private readonly scope: CacheScope,
		private readonly openings: RecentOpenings
	) {
		this.disk = new SnapshotStorage(scope);
		document.addEventListener('visibilitychange', this.visibility);
	}
	subscribe(
		listener: (data: ReadyContract) => void,
		evict: (id: string) => void,
		failed: (id: string) => void
	) {
		this.listeners.add(listener);
		this.evictions.add(evict);
		this.failures.add(failed);
		return () => {
			this.listeners.delete(listener);
			this.evictions.delete(evict);
			this.failures.delete(failed);
		};
	}
	peek(id: string) {
		return this.entries.get(id)?.data;
	}

	/** Seeds only a server-confirmed contract; snapshot identity survives the route handoff. */
	seedConfirmed(data: ReadyContract): ReadyContract | undefined {
		const id = data.id;
		if (this.deleted.has(id) || this.lifetime.signal.aborted || !validSnapshot(data, id)) return;
		const existing = this.peek(id);
		if (existing) {
			if (existing.contract.templateVersionId !== data.contract.templateVersionId) return;
			return this.updateState(id, data.contract) ?? existing;
		}
		this.cancelFlight(id, false);
		this.queued.delete(id);
		const entry = this.remember(id, data);
		if (entry) this.disk.put(entry, () => !this.deleted.has(id) && !this.lifetime.signal.aborted);
		const confirmed = entry?.data ?? data;
		for (const listener of this.listeners) listener(confirmed);
		return confirmed;
	}

	allowBackground() {
		this.backgroundAllowed = true;
		this.pump();
	}
	pauseBackground() {
		this.backgroundAllowed = false;
		for (const [id, flight] of this.flights) if (flight.background) this.cancelFlight(id, false);
	}

	/** Fetch exactly the resources selected by the preparation policy, in priority order. */
	backgroundCandidates(ids: readonly string[]) {
		if (this.lifetime.signal.aborted) return;
		const selected = new Set(ids);
		for (const [id, flight] of this.flights)
			if (flight.background && !selected.has(id)) this.cancelFlight(id, false);
		this.queued = new Set(
			ids.filter((id) => !this.deleted.has(id) && !this.touch(id) && !this.flights.has(id))
		);
		this.pump();
	}

	/** Confirmed deletion, distinct from memory eviction. */
	remove(id: string) {
		if (this.deleted.has(id) || this.lifetime.signal.aborted) return;
		this.deleted.add(id);
		this.evict(id);
		this.disk.delete(id);
		this.openings.forget(id);
		for (const listener of this.evictions) listener(id);
	}
	isDeleted(id: string) {
		return this.deleted.has(id);
	}
	private forgetEntry(id: string) {
		const entry = this.entries.get(id);
		if (!entry) return;
		this.bytes -= entry.bytes - entry.immutableBytes;
		const versionId = entry.data.contract.templateVersionId;
		const version = this.versions.get(versionId)!;
		version.references--;
		this.entries.delete(id);
	}
	private evict(id: string) {
		this.forgetEntry(id);
		this.queued.delete(id);
		this.cancelFlight(id);
	}

	private touch(id: string) {
		const entry = this.entries.get(id);
		if (!entry) return;
		this.entries.delete(id);
		this.entries.set(id, entry);
		return entry.data;
	}

	private enforceLimits() {
		while (
			this.entries.size > MAX_ENTRIES ||
			this.versions.size > MAX_ENTRIES ||
			this.bytes > MAX_BYTES
		) {
			const unused = [...this.versions].find(([, version]) => !version.references);
			if (unused) {
				this.versions.delete(unused[0]);
				this.bytes -= unused[1].bytes;
				continue;
			}
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.evict(oldest);
		}
	}

	connect(client: SnapshotClient) {
		this.client = client;
	}

	/** A single bounded, authenticated read per version, shared by all consumers. */
	async loadVersion(
		versionId: Id<'templateVersions'>,
		companyId: Id<'company'>,
		signal?: AbortSignal
	): Promise<TemplateContent> {
		signal?.throwIfAborted();
		this.lifetime.signal.throwIfAborted();
		const cached = this.versions.get(versionId);
		if (cached) {
			this.versions.delete(versionId);
			this.versions.set(versionId, cached);
			return cached.snapshot;
		}
		let flight = this.versionFlights.get(versionId);
		if (!flight) {
			const attempt = new ReadAttempt(15_000, this.lifetime.signal);
			const readSignal = attempt.signal;
			const work = Promise.resolve().then(async () => {
				const diskAttempt = new ReadAttempt(250, readSignal);
				let persisted: TemplateContent | undefined;
				try {
					const diskSignal = diskAttempt.signal;
					persisted = await waitForRead(
						this.disk.getVersion(versionId, companyId, diskSignal),
						diskSignal
					);
				} catch {
					readSignal.throwIfAborted();
				} finally {
					diskAttempt.complete();
				}
				readSignal.throwIfAborted();
				if (!this.membershipId || !this.client) throw new Error('Company access is required.');
				const storedSnapshot =
					persisted ??
					(await queryOnce(
						this.client,
						api.templates.content,
						{
							membershipId: this.membershipId,
							versionId
						},
						readSignal
					));
				readSignal.throwIfAborted();
				if (!persisted && !validTemplate(storedSnapshot, companyId))
					throw new Error('Invalid template');
				const snapshot = storedSnapshot;
				if (this.versionFlights.get(versionId) !== created)
					throw new Error('The request was replaced.');
				const bytes = JSON.stringify(snapshot).length * 2;
				if (bytes <= MAX_BYTES && !this.versions.has(versionId)) {
					this.versions.set(versionId, { snapshot, bytes, references: 0 });
					this.bytes += bytes;
					this.enforceLimits();
				}
				return this.versions.get(versionId)?.snapshot ?? snapshot;
			});
			const created: VersionFlight = {
				attempt,
				consumers: 0,
				result: waitForRead(work, readSignal).finally(() => {
					attempt.complete();
					if (this.versionFlights.get(versionId) === created) this.versionFlights.delete(versionId);
				})
			};
			this.versionFlights.set(versionId, created);
			flight = created;
		}
		flight.consumers++;
		try {
			return await waitForRead(flight.result, signal, this.lifetime.signal);
		} finally {
			if (--flight.consumers === 0 && this.versionFlights.get(versionId) === flight) {
				this.versionFlights.delete(versionId);
				flight.attempt.abort();
			}
		}
	}

	private remember(id: string, data: ReadyContract) {
		const versionId = data.contract.templateVersionId;
		const shared = this.versions.get(versionId);
		const contractJson = JSON.stringify(data.contract);
		const immutableBytes = shared?.bytes ?? JSON.stringify(data.snapshot).length * 2;
		const bytes = immutableBytes + contractJson.length * 2;
		this.forgetEntry(id);
		if (bytes > MAX_BYTES) return;
		const version = shared ?? { snapshot: data.snapshot, bytes: immutableBytes, references: 0 };
		if (!this.versions.has(versionId)) {
			this.versions.set(versionId, version);
			this.bytes += immutableBytes;
		}
		version.references++;
		if (data.snapshot !== version.snapshot) data = { ...data, snapshot: version.snapshot };
		const entry = { data, bytes, immutableBytes, contractJson };
		this.entries.set(id, entry);
		this.bytes += contractJson.length * 2;
		this.enforceLimits();
		return entry;
	}

	/** Refresh confirmed metadata, including existing disk-only entries. */
	confirmMetadata(contract: ReadyContract['contract']) {
		const id = contract._id;
		if (this.deleted.has(id) || this.lifetime.signal.aborted) return;
		if (this.entries.has(id)) return this.updateState(id, contract);
		// Refresh an existing disk-only entry without loading or rewriting its content.
		this.disk.updateContract(
			id,
			contract,
			JSON.stringify(contract).length * 2,
			() => !this.deleted.has(id) && !this.lifetime.signal.aborted
		);
	}

	/** Only confirmed server state belongs here. Never inserts a missing entry. */
	updateState(id: string, state: ContractState) {
		const entry = this.entries.get(id);
		if (!entry || this.deleted.has(id) || this.lifetime.signal.aborted) return;
		const previous = entry.data.contract;
		if (olderContractState(state, previous)) return entry.data;
		const contract = { ...previous, ...state };
		const contractJson = JSON.stringify(contract);
		if (contractJson === entry.contractJson) return entry.data;
		const contractBytes = contractJson.length * 2;
		const bytes = entry.immutableBytes + contractBytes;
		this.bytes += bytes - entry.bytes;
		entry.bytes = bytes;
		entry.contractJson = contractJson;
		entry.data = { ...entry.data, contract };
		this.disk.updateContract(
			id,
			contract,
			contractBytes,
			() => !this.deleted.has(id) && !this.lifetime.signal.aborted
		);
		this.enforceLimits();
		if (this.entries.get(id) === entry) for (const listener of this.listeners) listener(entry.data);
		return entry.data;
	}

	private cancelFlight(id: string, failed = true) {
		const flight = this.flights.get(id);
		if (!flight) return;
		this.flights.delete(id);
		flight.attempt.abort();
		if (failed) for (const listener of this.failures) listener(id);
	}

	/** Cancel reads and queued work without discarding confirmed snapshots or writes. */
	cancelPending() {
		this.pauseBackground();
		this.queued.clear();
		for (const id of this.flights.keys()) this.cancelFlight(id);
		for (const flight of this.versionFlights.values()) flight.attempt.abort();
		this.versionFlights.clear();
	}

	private fetchFull(id: string, background = false) {
		if (this.deleted.has(id)) return Promise.resolve({ id, status: 'missing' } as const);
		if (this.lifetime.signal.aborted) return Promise.resolve({ id, status: 'error' } as const);
		const existing = this.flights.get(id);
		if (existing) return existing.result;
		this.queued.delete(id);
		const attempt = new ReadAttempt(15_000, this.lifetime.signal);
		const signal = attempt.signal;
		const work = Promise.resolve().then(async () => {
			signal.throwIfAborted();
			const diskAttempt = new ReadAttempt(250, signal);
			const diskSignal = diskAttempt.signal;
			let persisted: SnapshotMetadata | undefined;
			try {
				persisted = await waitForRead(this.disk.getMetadata(id, diskSignal), diskSignal);
			} catch {
				signal.throwIfAborted();
				// IndexedDB is optional. A failed or stalled read falls through to the network.
			} finally {
				diskAttempt.complete();
			}
			signal.throwIfAborted();
			if (this.deleted.has(id)) return { id, status: 'missing' } as const;
			recordColdStart(persisted ? 'contract-disk-cache-hit' : 'contract-snapshot-fetch-start');
			if (!this.membershipId) throw new Error('Company access is required.');
			const state =
				persisted?.contract ??
				(this.client
					? await queryOnce(
							this.client,
							api.contracts.state,
							{ id, membershipId: this.membershipId },
							signal
						)
					: undefined);
			if (state === undefined) throw new Error('Contract client is unavailable.');
			const result = state
				? {
						id,
						status: 'ready' as const,
						contract: state,
						snapshot: await this.loadVersion(state.templateVersionId, state.companyId, signal)
					}
				: { id, status: 'missing' as const };
			signal.throwIfAborted();
			if (this.flights.get(id) !== flight) throw new Error('The request was replaced.');
			if (result.status === 'missing') {
				this.flights.delete(id);
				this.remove(id);
			}
			if (result.status === 'ready') {
				if (this.deleted.has(id)) return { id, status: 'missing' } as const;
				const entry = this.remember(id, result);
				if (entry)
					this.disk.put(entry, () => !this.deleted.has(id) && !this.lifetime.signal.aborted);
				recordColdStart('contract-snapshot-cached');
				for (const listener of this.listeners) listener(this.entries.get(id)?.data ?? result);
			}
			return result.status === 'ready' ? (this.peek(id) ?? result) : result;
		});
		const flight: Flight = {
			attempt,
			background,
			result: waitForRead(work, signal)
				.catch(() => {
					if (this.flights.get(id) === flight) for (const listener of this.failures) listener(id);
					return { id, status: 'error' } as const;
				})
				.finally(() => {
					attempt.complete();
					if (this.flights.get(id) === flight) this.flights.delete(id);
					this.pump();
				})
		};
		this.flights.set(id, flight);
		return flight.result;
	}

	private pump() {
		if (this.lifetime.signal.aborted || !this.backgroundAllowed || document.hidden) return;
		while (
			[...this.flights.values()].filter((flight) => flight.background).length <
				BACKGROUND_CONCURRENCY &&
			this.queued.size
		) {
			const id = this.queued.values().next().value!;
			this.queued.delete(id);
			if (this.deleted.has(id) || this.entries.has(id) || this.flights.has(id)) continue;
			// All saved contracts share route code. Do not run its loader speculatively.
			this.code ??= preloadCode(`/contracts/${id}`).catch(() => {
				this.code = undefined;
			});
			void this.fetchFull(id, true);
		}
	}

	load(
		id: string,
		client?: SnapshotClient,
		options: { restart?: boolean } = {}
	): Promise<ContractSnapshotResult> {
		if (client) this.connect(client);
		if (options.restart) this.cancelFlight(id, false);
		// Claim the matching flight before pausing the other background reads.
		const pending = this.flights.get(id);
		if (pending) pending.background = false;
		this.pauseBackground();
		this.queued.delete(id);
		if (this.deleted.has(id)) return Promise.resolve({ id, status: 'missing' });
		const cached = this.touch(id);
		if (cached) {
			recordColdStart('contract-cache-hit');
			return Promise.resolve(cached);
		}
		recordColdStart('contract-cache-miss');
		return this.fetchFull(id);
	}

	destroy() {
		document.removeEventListener('visibilitychange', this.visibility);
		this.listeners.clear();
		this.evictions.clear();
		this.failures.clear();
		this.lifetime.abort();
		this.disk.close();
		this.flights.clear();
		this.versionFlights.clear();
		this.entries.clear();
		this.versions.clear();
		this.queued.clear();
		this.bytes = 0;
	}
}

/** Account-owned resources survive route changes and always share one immutable scope. */
function scopedResources(scope: CacheScope) {
	return {
		scope,
		openings: new RecentOpenings(scope),
		cache: undefined as ContractSnapshotCache | undefined
	};
}
let resources = scopedResources(createCacheScope(null));

export function replaceContractCacheScope(scope: CacheScope) {
	if (resources.scope.namespace === scope.namespace) return;
	releaseContractSnapshotCache();
	resources.openings.close();
	clearConfirmedCache(resources.scope);
	resources = scopedResources(scope);
}
export function getContractSnapshotCache(client?: SnapshotClient) {
	if (!browser) throw new Error('Contract snapshot cache is browser-only.');
	const cache = (resources.cache ??= new ContractSnapshotCache(
		resources.scope,
		resources.openings
	));
	if (client) cache.connect(client);
	return cache;
}
export const getContractOpenings = () => resources.openings;
export function cancelPendingContractSnapshots() {
	resources.cache?.cancelPending();
}
export function releaseContractSnapshotCache() {
	resources.cache?.destroy();
	resources.cache = undefined;
}
/** Registered once with the account lifecycle; it survives entry/workspace navigation. */
export const contractCacheResources = {
	cancelReads: cancelPendingContractSnapshots,
	clear: () => {
		releaseContractSnapshotCache();
		resources.openings.close();
		clearConfirmedCache(resources.scope);
		const scope = createCacheScope(null);
		resources = scopedResources(scope);
	}
};
