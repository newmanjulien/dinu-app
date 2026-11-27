import type { TemplateContent } from '../template/model';
import { browser } from '$app/environment';
import { preloadCode } from '$app/navigation';
import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
import { recordColdStart } from '$lib/document/runtime/render-perf';
import { api } from '../../convex/_generated/api';
import type { FunctionReturnType } from 'convex/server';
import type { Id } from '../../convex/_generated/dataModel';
import { clearConfirmedCache, createCacheScope, type CacheScope } from './browser-storage';
import { retirePersistentCaches } from '$lib/auth/persistent-cache-registry';
import {
	olderContractState,
	persistedContractMetadata,
	type ContractSnapshotResult,
	type ContractState,
	type ReadyContract
} from './saved';
import type { SnapshotEntry } from './snapshot-storage';
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
/** One saved opening shares its optional disk result, including a settled miss or timeout. */
export type SavedOpening = { id: string };
type ImmutableRead = { opening?: SavedOpening; diskChecked?: boolean };

type LiveState = FunctionReturnType<typeof api.contracts.state>;
type TemplateHint = { versionId: Id<'templateVersions'>; companyId: Id<'company'> };

type Entry = SnapshotEntry & { contractJson: string };
type Flight = {
	result: Promise<ContractSnapshotResult>;
	attempt: ReadAttempt;
	opening: SavedOpening;
	background: boolean;
	demand: number;
};
const MAX_ENTRIES = SNAPSHOT_ENTRIES;
const MAX_BYTES = SNAPSHOT_BYTES;
const BACKGROUND_CONCURRENCY = 2;
const CANDIDATE_GRACE_MS = 500;

/** Browser-only, membership-scoped snapshots. Mutable state is refreshed on every open. */
class ContractSnapshotCache {
	private disk: SnapshotStorage;
	private get membershipId() {
		return this.scope.membershipId;
	}
	private client: SnapshotClient | undefined;
	private versionFlights = new Map<string, VersionFlight>();
	private hints = new Map<string, TemplateHint>();
	private backoff = new Map<string, { until: number; failures: number }>();
	private epochs = new Map<string, number>();
	private deleted = new Set<string>();
	private entries = new Map<string, Entry>();
	private versions = new Map<
		string,
		{ snapshot: ReadyContract['snapshot']; bytes: number; references: number }
	>();
	private flights = new Map<string, Flight>();
	private reservation?: {
		id: string;
		flight: Flight;
		phase: 'intent' | 'navigation';
		timer?: ReturnType<typeof setTimeout>;
	};
	private queued = new Set<string>();
	private backgroundIds = new Set<string>();
	private urgentIds = new Set<string>();
	private displaced = new Map<string, { flight: Flight; timer: ReturnType<typeof setTimeout> }>();
	private bytes = 0;
	private backgroundAllowed = false;
	private lifetime = new AbortController();
	private code: Promise<void> | undefined;
	private listeners = new Set<(data: ReadyContract) => void>();
	private evictions = new Set<(id: string) => void>();
	private failures = new Set<(id: string) => void>();
	private visibility = () => {
		if (document.hidden) this.releaseReservation();
		this.pump();
	};
	constructor(private readonly scope: CacheScope) {
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
	hint(id: string, versionId: Id<'templateVersions'>, companyId: Id<'company'>) {
		if (this.lifetime.signal.aborted || this.deleted.has(id)) return;
		this.hints.delete(id);
		this.hints.set(id, { versionId, companyId });
		if (this.hints.size > 256) this.hints.delete(this.hints.keys().next().value!);
	}
	templateHint(id: string) {
		return this.hints.get(id);
	}
	private canWarm(id: string) {
		return (this.backoff.get(id)?.until ?? 0) <= Date.now();
	}
	peek(id: string) {
		return this.entries.get(id)?.data;
	}
	/** Mutable state is retained only in this workspace's memory. */
	async restore(
		id: string,
		signal?: AbortSignal,
		_opening?: SavedOpening
	): Promise<ReadyContract | undefined> {
		if (!signal?.aborted && !this.lifetime.signal.aborted) return this.peek(id);
	}
	/** Delivered access rejection purges previews without treating a retry as a deletion. */
	invalidate(id: string) {
		this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
		this.evict(id);
		for (const listener of this.evictions) listener(id);
	}
	/** Callers supply frozen-loader content; metadata confirmation alone cannot certify a preview. */
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
		if (entry)
			this.disk.put(
				entry.data.contract.templateVersionId,
				entry.data.snapshot,
				entry.immutableBytes,
				() => !this.lifetime.signal.aborted
			);
		const confirmed = entry?.data ?? data;
		for (const listener of this.listeners) listener(confirmed);
		return confirmed;
	}
	allowBackground() {
		this.backgroundAllowed = true;
		this.pump();
	}
	/** Transient interaction stops new work without discarding downloads already in progress. */
	suspendBackground() {
		this.backgroundAllowed = false;
	}
	pauseBackground() {
		this.suspendBackground();
		for (const [id, flight] of this.flights)
			if (this.abandoned(id, flight)) this.cancelFlight(id, false);
	}
	private abandoned(id: string, flight: Flight) {
		return (
			!flight.demand &&
			this.reservation?.flight !== flight &&
			(!flight.background || !this.backgroundAllowed || !this.backgroundIds.has(id))
		);
	}
	/** Capture protects only an existing download; it never starts speculative data. */
	reserveIntent(id: string) {
		const flight = this.flights.get(id);
		if (this.reservation?.id !== id || this.reservation.flight !== flight)
			this.releaseReservation();
		if (!flight || this.reservation?.phase === 'navigation') return;
		clearTimeout(this.reservation?.timer);
		const reservation = { id, flight, phase: 'intent' as const };
		this.reservation = reservation;
		this.reservation.timer = setTimeout(() => this.releaseReservation(reservation), 1500);
	}
	/** Kit calls beforeNavigate before publishing navigating (and Home's pause). */
	reserveNavigation(id?: string) {
		if (this.reservation?.id !== id) this.releaseReservation();
		const flight = id ? this.flights.get(id) : undefined;
		clearTimeout(this.reservation?.timer);
		this.reservation = id && flight ? { id, flight, phase: 'navigation' } : undefined;
		const reservation = this.reservation;
		return () => {
			if (reservation) this.releaseReservation(reservation);
		};
	}
	private releaseReservation(expected = this.reservation) {
		if (!expected || this.reservation !== expected) return;
		clearTimeout(expected.timer);
		this.reservation = undefined;
		if (
			this.flights.get(expected.id) === expected.flight &&
			this.abandoned(expected.id, expected.flight)
		)
			this.cancelFlight(expected.id, false);
	}
	private clearDisplacement(id: string) {
		const displaced = this.displaced.get(id);
		if (!displaced) return;
		clearTimeout(displaced.timer);
		this.displaced.delete(id);
	}
	/** Keep displaced downloads briefly; a promoted card may claim their slot immediately. */
	backgroundCandidates(ids: readonly string[], urgentIds: readonly string[] = []) {
		if (this.lifetime.signal.aborted) return;
		const selected = new Set(ids);
		this.backgroundIds = selected;
		this.urgentIds = new Set(urgentIds);
		for (const [id, flight] of this.flights) {
			if (
				selected.has(id) ||
				!flight.background ||
				flight.demand ||
				this.reservation?.flight === flight
			) {
				this.clearDisplacement(id);
				continue;
			}
			if (this.displaced.has(id)) continue;
			const timer = setTimeout(() => {
				this.displaced.delete(id);
				if (
					this.flights.get(id) === flight &&
					!this.backgroundIds.has(id) &&
					!flight.demand &&
					this.reservation?.flight !== flight
				)
					this.cancelFlight(id, false);
				this.pump();
			}, CANDIDATE_GRACE_MS);
			this.displaced.set(id, { flight, timer });
		}
		const missing = ids.filter(
			(id) => !this.deleted.has(id) && this.canWarm(id) && !this.touch(id) && !this.flights.has(id)
		);
		this.queued = new Set([
			...missing.filter((id) => this.urgentIds.has(id)),
			...missing.filter((id) => !this.urgentIds.has(id))
		]);
		this.pump();
	}
	/** Confirmed deletion, distinct from memory eviction. */
	remove(id: string) {
		if (this.deleted.has(id) || this.lifetime.signal.aborted) return;
		this.deleted.add(id);
		this.hints.delete(id);
		this.backoff.delete(id);
		this.evict(id);
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
		if (this.reservation?.id === id) this.releaseReservation();
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
	/** Only frozen versions enter this cache; one bounded read is shared by all consumers. */
	async loadFrozenVersion(
		versionId: Id<'templateVersions'>,
		companyId: Id<'company'>,
		signal?: AbortSignal,
		{ opening, diskChecked = false }: ImmutableRead = {}
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
				let persisted: TemplateContent | undefined;
				if (!diskChecked) {
					const diskAttempt = new ReadAttempt(250, readSignal);
					try {
						persisted = await waitForRead(
							this.disk.getVersion(versionId, companyId, diskAttempt.signal),
							diskAttempt.signal
						);
					} catch {
						readSignal.throwIfAborted();
					} finally {
						diskAttempt.complete();
					}
				}
				readSignal.throwIfAborted();
				if (!this.membershipId || !this.client) throw new Error('Company access is required.');
				const storedSnapshot =
					this.versions.get(versionId)?.snapshot ??
					persisted ??
					(await queryOnce(
						this.client,
						api.templates.frozenContent,
						{
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
				if (!persisted)
					this.disk.put(versionId, snapshot, bytes, () => !this.lifetime.signal.aborted);
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
		return this.entries.get(id);
	}
	/** Live metadata can update an existing in-memory preview. */
	confirmMetadata(contract: ReadyContract['contract']) {
		return this.updateState(contract._id, contract);
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
		this.enforceLimits();
		if (this.entries.get(id) === entry) for (const listener of this.listeners) listener(entry.data);
		return entry.data;
	}
	private cancelFlight(id: string, failed = true) {
		this.clearDisplacement(id);
		const flight = this.flights.get(id);
		if (!flight) return;
		this.flights.delete(id);
		flight.attempt.abort();
		if (failed) for (const listener of this.failures) listener(id);
	}
	/** Cancel reads and queued work without discarding confirmed snapshots or writes. */
	cancelPending() {
		this.releaseReservation();
		this.pauseBackground();
		this.queued.clear();
		this.backgroundIds.clear();
		this.urgentIds.clear();
		for (const id of this.flights.keys()) this.cancelFlight(id);
		for (const flight of this.versionFlights.values()) flight.attempt.abort();
		this.versionFlights.clear();
	}
	private fetchFull(id: string, background = false, state?: Promise<LiveState>) {
		if (this.deleted.has(id)) return Promise.resolve({ id, status: 'missing' } as const);
		if (this.lifetime.signal.aborted) return Promise.resolve({ id, status: 'error' } as const);
		const existing = this.flights.get(id);
		if (existing) return existing.result;
		this.queued.delete(id);
		const attempt = new ReadAttempt(15_000, this.lifetime.signal);
		const signal = attempt.signal;
		const opening: SavedOpening = { id };
		const work = Promise.resolve().then(async () => {
			signal.throwIfAborted();
			if (this.deleted.has(id)) return { id, status: 'missing' } as const;
			recordColdStart('contract-snapshot-fetch-start');
			if (!this.membershipId) throw new Error('Company access is required.');
			const hint = this.templateHint(id);
			const hinted = hint
				? this.loadFrozenVersion(hint.versionId, hint.companyId, signal).then(
						(snapshot) => ({ snapshot }),
						() => undefined
					)
				: undefined;
			const live = state
				? await waitForRead(state, signal)
				: this.client
					? await queryOnce(this.client, api.contracts.state, { id }, signal)
					: undefined;
			if (live === undefined) throw new Error('Contract client is unavailable.');
			const contract = live
				? persistedContractMetadata(live as Parameters<typeof persistedContractMetadata>[0])
				: null;
			const result = contract
				? {
						id,
						status: 'ready' as const,
						contract,
						snapshot:
							(hint?.versionId === contract.templateVersionId
								? (await hinted)?.snapshot
								: undefined) ??
							(await this.loadFrozenVersion(contract.templateVersionId, contract.companyId, signal))
					}
				: { id, status: 'missing' as const };
			signal.throwIfAborted();
			if (this.flights.get(id) !== flight) throw new Error('The request was replaced.');
			if (result.status === 'missing') {
				this.flights.delete(id);
				this.remove(id);
			}
			if (result.status === 'ready') {
				this.backoff.delete(id);
				if (this.deleted.has(id)) return { id, status: 'missing' } as const;
				const entry = this.remember(id, result);
				if (entry)
					this.disk.put(
						entry.data.contract.templateVersionId,
						entry.data.snapshot,
						entry.immutableBytes,
						() => !this.lifetime.signal.aborted
					);
				recordColdStart('contract-snapshot-cached');
				for (const listener of this.listeners) listener(this.entries.get(id)?.data ?? result);
			}
			return result.status === 'ready' ? (this.peek(id) ?? result) : result;
		});
		const flight: Flight = {
			attempt,
			opening,
			background,
			demand: 0,
			result: waitForRead(work, signal)
				.catch(() => {
					if (background && !signal.aborted) {
						const failures = (this.backoff.get(id)?.failures ?? 0) + 1;
						this.backoff.set(id, {
							failures,
							until: Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(failures - 1, 5))
						});
					}
					if (this.flights.get(id) === flight) for (const listener of this.failures) listener(id);
					return { id, status: 'error' } as const;
				})
				.finally(() => {
					attempt.complete();
					if (this.flights.get(id) === flight) {
						this.clearDisplacement(id);
						this.flights.delete(id);
					}
					this.pump();
				})
		};
		this.flights.set(id, flight);
		return flight.result;
	}
	private pump() {
		if (
			this.lifetime.signal.aborted ||
			!this.backgroundAllowed ||
			document.hidden ||
			!this.client ||
			!this.membershipId
		)
			return;
		let active = [...this.flights.values()].filter(
			(flight) => flight.background && !flight.demand
		).length;
		if (active >= BACKGROUND_CONCURRENCY && [...this.queued].some((id) => this.urgentIds.has(id))) {
			const stale = [...this.displaced].find(
				([id, { flight }]) =>
					this.flights.get(id) === flight && !flight.demand && this.reservation?.flight !== flight
			);
			if (stale) {
				this.cancelFlight(stale[0], false);
				active--;
			}
		}
		const selected: string[] = [];
		for (const id of this.queued) {
			if (selected.length >= BACKGROUND_CONCURRENCY - active) break;
			this.queued.delete(id);
			if (this.deleted.has(id) || !this.canWarm(id) || this.entries.has(id) || this.flights.has(id))
				continue;
			selected.push(id);
		}
		if (!selected.length) return;
		this.code ??= preloadCode(`/contracts/${selected[0]}`).catch(() => {
			this.code = undefined;
		});
		const batch = new ReadAttempt(15_000, this.lifetime.signal);
		const states = queryOnce(
			this.client,
			api.contracts.batchState,
			{ ids: selected },
			batch.signal
		).finally(() => batch.complete());
		for (const id of selected)
			void this.fetchFull(
				id,
				true,
				states.then((rows) => rows.find((row) => row?._id === id) ?? null)
			);
		const signals = selected.map((id) => this.flights.get(id)!.attempt.signal);
		const canceled = () => {
			if (signals.every((signal) => signal.aborted)) batch.abort();
		};
		for (const signal of signals) signal.addEventListener('abort', canceled, { once: true });
		void states
			.then(
				() => {},
				() => {}
			)
			.finally(() => {
				for (const signal of signals) signal.removeEventListener('abort', canceled);
			});
	}
	load(
		id: string,
		client?: SnapshotClient,
		options: { restart?: boolean; signal?: AbortSignal } = {}
	): Promise<ContractSnapshotResult> {
		if (options.signal?.aborted) return Promise.resolve({ id, status: 'error' });
		if (client) this.connect(client);
		if (options.restart) this.cancelFlight(id, false);
		this.queued.delete(id);
		if (this.deleted.has(id)) {
			this.releaseReservation();
			this.pauseBackground();
			return Promise.resolve({ id, status: 'missing' });
		}
		const cached = this.touch(id);
		if (cached) {
			if (this.reservation?.id === id) this.releaseReservation();
			this.pauseBackground();
			recordColdStart('contract-cache-hit');
			return Promise.resolve(cached);
		}
		recordColdStart('contract-cache-miss');
		const result = this.fetchFull(id);
		const flight = this.flights.get(id);
		if (flight) {
			flight.demand++;
			this.clearDisplacement(id);
		}
		if (this.reservation?.id === id) this.releaseReservation();
		this.pauseBackground();
		return waitForRead(result, options.signal)
			.catch(() => ({ id, status: 'error' as const }))
			.finally(() => {
				if (!flight) return;
				flight.demand--;
				if (this.flights.get(id) === flight && this.abandoned(id, flight))
					this.cancelFlight(id, false);
			});
	}
	destroy() {
		this.releaseReservation();
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
		this.hints.clear();
		this.backoff.clear();
		this.queued.clear();
		this.backgroundIds.clear();
		this.urgentIds.clear();
		for (const id of this.displaced.keys()) this.clearDisplacement(id);
		this.bytes = 0;
	}
}

/** Account-owned resources survive route changes and always share one immutable scope. */
function scopedResources(scope: CacheScope) {
	return {
		scope,
		cache: undefined as ContractSnapshotCache | undefined
	};
}
let resources = scopedResources(createCacheScope(null));

export function replaceContractCacheScope(scope: CacheScope) {
	if (resources.scope.namespace === scope.namespace && resources.scope.userId === scope.userId)
		return;
	releaseContractSnapshotCache();
	clearConfirmedCache(resources.scope);
	retirePersistentCaches(
		scope.userId && scope.membershipId
			? { userId: scope.userId, membershipId: scope.membershipId }
			: undefined
	);
	resources = scopedResources(scope);
}
export function getContractSnapshotCache(client?: SnapshotClient) {
	if (!browser) throw new Error('Contract snapshot cache is browser-only.');
	const cache = (resources.cache ??= new ContractSnapshotCache(resources.scope));
	if (client) cache.connect(client);
	return cache;
}
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
		resources = scopedResources(createCacheScope(null));
	},
	captureMembershipRetirement: ({
		userId,
		membershipId
	}: {
		userId: string;
		membershipId: string;
	}) => {
		const retiring = resources;
		const cache = retiring.cache;
		return () => {
			if (
				resources !== retiring ||
				resources.cache !== cache ||
				retiring.scope.userId !== userId ||
				retiring.scope.membershipId !== membershipId
			)
				return;
			releaseContractSnapshotCache();
			resources = scopedResources(createCacheScope(null));
		};
	},
	forgetAccount: (userId: string) => {
		if (resources.scope.userId === userId) {
			releaseContractSnapshotCache();
			resources = scopedResources(createCacheScope(null));
		}
	}
};
