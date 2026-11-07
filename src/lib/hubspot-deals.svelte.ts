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

	constructor(
		readonly options: {
			client: Pick<ConvexClient, 'action'>;
			membershipId: Id<'memberships'>;
			connection: { readonly data: Connection | undefined; readonly error: Error | undefined };
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
			connection?.enabled &&
			connection.status === 'connected'
			? JSON.stringify([identity, connection.accountId, connection.installedAt])
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
	}

	load(search = '', force = false): Promise<DealPage | undefined> {
		const owner = this.identity;
		this.align(owner);
		if (!owner) return Promise.resolve(undefined);
		const term = search.trim().slice(0, 200);
		if (!force && !term && this.cache && Date.now() - this.cache.at < freshness)
			return Promise.resolve(this.cache.page);
		const existing = this.requests.get(term);
		if (existing) return existing;
		const request = this.options.client
			.action(api.hubspotDeals.list, {
				membershipId: this.options.membershipId,
				search: term
			})
			.then(
				(page) => {
					if (this.identity !== owner || this.requests.get(term) !== request) return;
					if (!term) this.cache = { owner, page, at: Date.now() };
					return page;
				},
				(error: unknown) => {
					if (this.identity === owner && this.requests.get(term) === request) throw error;
					return undefined;
				}
			)
			.finally(() => {
				if (this.requests.get(term) === request) this.requests.delete(term);
			});
		this.requests.set(term, request);
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
