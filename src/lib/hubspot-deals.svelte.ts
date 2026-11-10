import { ReadAttempt, waitForRead } from './auth/attempt';
import { getContext, setContext } from 'svelte';
import type { ConvexClient } from 'convex/browser';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';

type Connection = FunctionReturnType<typeof api.hubspotConnections.status>;
export type DealPage = FunctionReturnType<typeof api.hubspotDeals.list>;
const key = Symbol('hubspot-deals');
const freshness = 45_000;

/** A workspace owns one small browse page; typed searches only share in-flight requests. */
export class HubSpotDeals {
	private cache = $state.raw<{ owner: string; page: DealPage; at: number }>();
	private owner: string | null = null;
	private requests = new Map<string, Promise<DealPage | undefined>>();
	private destroyed = false;
	private attempts = new Set<ReadAttempt>();

	constructor(
		readonly options: {
			client: Pick<ConvexClient, 'action'>;
			membershipId: Id<'memberships'>;
			connection: {
				readonly data: Connection | undefined;
				readonly error: Error | undefined;
				readonly isLoading?: boolean;
				retry?: () => void;
			};
			identity: () => string | null;
		}
	) {}

	get connection() {
		return this.options.connection;
	}

	get identity() {
		const identity = this.options.identity();
		const connection = this.connection.data;
		return !this.destroyed &&
			identity &&
			!this.connection.error &&
			!this.connection.isLoading &&
			connection?.enabled &&
			connection.status === 'connected'
			? JSON.stringify([
					identity,
					connection.connectionId,
					connection.accountId,
					connection.installedAt
				])
			: null;
	}

	get initialPage() {
		return this.cache?.owner === this.identity ? this.cache?.page : undefined;
	}

	align(owner: string | null) {
		if (owner === this.owner) return;
		this.owner = owner;
		this.cache = undefined;
		this.requests.clear();
		for (const attempt of this.attempts) attempt.abort();
		this.attempts.clear();
	}

	load(search = '', force = false, cursor?: string): Promise<DealPage | undefined> {
		const owner = this.identity;
		this.align(owner);
		if (!owner) return Promise.resolve(undefined);
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
					if (initial) this.cache = { owner, page, at: Date.now() };
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
		// A speculative failure must never be retained or prevent a foreground retry.
		void this.load().catch(() => {});
	}

	destroy() {
		this.destroyed = true;
		this.align(null);
	}
}

export const setHubSpotDeals = (resource: HubSpotDeals) => setContext(key, resource);
export const useHubSpotDeals = () => getContext<HubSpotDeals>(key);
