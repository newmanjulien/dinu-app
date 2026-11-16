import { ReadAttempt, waitForRead } from './auth/attempt';
import { createReadQuery } from './auth/read-query.svelte';
import { getContext, setContext, untrack } from 'svelte';
import type { ConvexClient } from 'convex/browser';
import type { FunctionReturnType } from 'convex/server';
import type { SnapshotClient } from './query-once';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';

type Connection = FunctionReturnType<typeof api.hubspotConnections.status>;
export type DealPage = FunctionReturnType<typeof api.hubspotDeals.list>;
type Eligibility = ReturnType<typeof createReadQuery<typeof api.hubspotDeals.eligibility>>;
export type DealEligibilityLease = { readonly read: Eligibility; release: () => void };
const key = Symbol('hubspot-deals');
const freshness = 45_000;

/** One browse page per installation. Retained names never confer current eligibility. */
export class HubSpotDeals {
	private cache = $state.raw<{ owner: string; page: DealPage; at: number }>();
	private acceptedConnection = $state.raw<{ owner: string; value: Connection }>();
	private owner: string | null = null;
	private requests = new Map<string, Promise<DealPage | undefined>>();
	private eligibility = new Map<string, { read: Eligibility; readers: number; stop: () => void }>();
	private destroyed = false;
	private attempts = new Set<ReadAttempt>();

	constructor(
		readonly options: {
			client: Pick<ConvexClient, 'action'> & Partial<SnapshotClient>;
			membershipId: Id<'memberships'>;
			connection: {
				readonly data: Connection | undefined;
				readonly error: Error | undefined;
				readonly isLoading?: boolean;
				readonly rejected?: boolean;
				retry?: () => void;
			};
			/** Stable account/session/workspace identity, excluding transport generation. */
			identity: () => string | null;
			generation?: () => number;
		}
	) {}

	get connection() {
		return this.options.connection;
	}
	get displayConnection() {
		const scope = this.options.identity();
		if (!scope || this.destroyed || this.connection.rejected) return undefined;
		return !this.connection.isLoading && !this.connection.error && this.connection.data
			? this.connection.data
			: this.acceptedConnection?.owner === scope
				? this.acceptedConnection.value
				: undefined;
	}
	get displayIdentity() {
		const scope = this.options.identity();
		const connection = this.displayConnection;
		return scope && connection?.enabled && connection.status === 'connected'
			? JSON.stringify([
					scope,
					connection.connectionId,
					connection.accountId,
					connection.installedAt
				])
			: null;
	}
	get identity() {
		return !this.destroyed &&
			!this.connection.error &&
			!this.connection.isLoading &&
			this.connection.data?.enabled &&
			this.connection.data.status === 'connected' &&
			this.displayIdentity
			? JSON.stringify([this.displayIdentity, this.options.generation?.() ?? 0])
			: null;
	}
	get initialPage() {
		return this.cache?.owner === this.displayIdentity ? this.cache?.page : undefined;
	}

	align(owner: string | null) {
		const scope = this.options.identity();
		if (!scope || this.destroyed || this.connection.rejected) this.acceptedConnection = undefined;
		else if (!this.connection.isLoading && !this.connection.error && this.connection.data)
			this.acceptedConnection = { owner: scope, value: this.connection.data };
		if (this.cache?.owner !== this.displayIdentity) this.cache = undefined;
		if (owner === this.owner) return;
		this.owner = owner;
		this.requests.clear();
		for (const attempt of this.attempts) attempt.abort();
		this.attempts.clear();
		for (const entry of this.eligibility.values()) entry.stop();
		this.eligibility.clear();
	}

	/** Exact IDs and target contract share a live observation, never a previous transport's result. */
	retainEligibility(
		dealIds: readonly string[],
		contractId?: Id<'savedContracts'>
	): DealEligibilityLease | undefined {
		const owner = this.identity;
		this.align(owner);
		const connection = this.connection.data;
		if (!owner || !connection?.accountId || connection.installedAt === null || !dealIds.length)
			return;
		const ids = [...new Set(dealIds)].sort().slice(0, 13);
		const id = JSON.stringify([owner, contractId ?? null, ids]);
		let entry = this.eligibility.get(id);
		if (!entry) {
			let read!: Eligibility;
			const stop = $effect.root(() => {
				read = createReadQuery(
					this.options.client as SnapshotClient,
					api.hubspotDeals.eligibility,
					{
						membershipId: this.options.membershipId,
						dealIds: ids,
						accountId: connection.accountId!,
						installedAt: connection.installedAt!,
						requestIdentity: owner,
						...(contractId ? { contractId } : {})
					}
				);
			});
			entry = { read, stop, readers: 0 };
			this.eligibility.set(id, entry);
		}
		entry.readers++;
		const retained = entry;
		let released = false;
		return {
			read: entry.read,
			release: () => {
				if (released) return;
				released = true;
				if (--retained.readers === 0) {
					retained.stop();
					if (this.eligibility.get(id) === retained) this.eligibility.delete(id);
				}
			}
		};
	}

	/** Intent and the mounted form overlap ownership, so opening adopts this observation. */
	retainOpening() {
		let lease: DealEligibilityLease | undefined;
		let leaseKey: string | undefined;
		let loadedOwner: string | null = null;
		const sync = () => {
			const owner = this.identity;
			const ids = [...new Set((this.initialPage?.deals ?? []).map((deal) => deal.id))]
				.slice(0, 12)
				.sort();
			const next = owner ? JSON.stringify([owner, ids]) : undefined;
			untrack(() => {
				if (next !== leaseKey) {
					const previous = lease;
					lease = this.retainEligibility(ids);
					leaseKey = next;
					previous?.release();
				}
				if (owner && owner !== loadedOwner) {
					loadedOwner = owner;
					this.prefetch();
				}
			});
		};
		// Synchronous acquisition matters: the incoming owner must hold the existing read
		// before the old intent/navigation lease releases it, even before the next flush.
		untrack(sync);
		const stop = $effect.root(() => {
			$effect(sync);
		});
		let released = false;
		return () => {
			if (released) return;
			released = true;
			stop();
			lease?.release();
		};
	}

	load(search = '', force = false, cursor?: string): Promise<DealPage | undefined> {
		const owner = this.identity;
		this.align(owner);
		if (!owner) return Promise.resolve(undefined);
		const display = this.displayIdentity!;
		const term = search.trim().slice(0, 200);
		const initial = !term && cursor === undefined;
		const requestKey = JSON.stringify([term, cursor ?? null]);
		if (!force && initial && this.cache && Date.now() - this.cache.at < freshness)
			return Promise.resolve(this.cache.page);
		const existing = this.requests.get(requestKey);
		if (existing) return existing;
		const attempt = new ReadAttempt(15_000);
		this.attempts.add(attempt);
		const request = waitForRead(
			this.options.client.action(api.hubspotDeals.list, {
				membershipId: this.options.membershipId,
				search: term,
				...(cursor !== undefined ? { cursor } : {})
			}),
			attempt.signal
		)
			.then(
				(page) => {
					if (this.identity !== owner || this.requests.get(requestKey) !== request) return;
					if (initial) this.cache = { owner: display, page, at: Date.now() };
					return page;
				},
				(error: unknown) => {
					if (this.identity === owner && this.requests.get(requestKey) === request) throw error;
					return undefined;
				}
			)
			.finally(() => {
				attempt.complete();
				this.attempts.delete(attempt);
				if (this.requests.get(requestKey) === request) this.requests.delete(requestKey);
			});
		this.requests.set(requestKey, request);
		return request;
	}
	prefetch() {
		void this.load().catch(() => {});
	}
	destroy() {
		this.destroyed = true;
		this.align(null);
	}
}
export const setHubSpotDeals = (resource: HubSpotDeals) => setContext(key, resource);
export const useHubSpotDeals = () => getContext<HubSpotDeals>(key);
