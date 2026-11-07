import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';
import type { Id } from '../../convex/_generated/dataModel';
import type { SavedContractCard } from './card';

export type CacheScope = Readonly<{
	namespace: string;
	membershipId: Id<'memberships'> | null;
}>;
export function createCacheScope(
	identity: { profileId: Id<'profiles'>; membershipId: Id<'memberships'> } | null
): CacheScope {
	return Object.freeze({
		namespace: `dinu:v4:${env.PUBLIC_CONVEX_URL ?? ''}:${identity ? `${identity.profileId}:${identity.membershipId}` : 'anonymous'}`,
		membershipId: identity?.membershipId ?? null
	});
}
export type Opening = { id: string; openedAt: number };

/** Only disposable, server-confirmed data belongs to this scope. Draft journals are separate. */
export function clearConfirmedCache(scope: CacheScope) {
	if (!browser) return;
	try {
		localStorage.removeItem(`${scope.namespace}:cards`);
		localStorage.removeItem(`${scope.namespace}:openings`);
	} catch {
		/* Optional cache. */
	}
	try {
		indexedDB.deleteDatabase(`${scope.namespace}:snapshots`);
	} catch {
		/* Optional cache. */
	}
}

export class RecentOpenings {
	private openings: Opening[] | undefined;
	private active = true;
	close() {
		this.active = false;
		this.openings = undefined;
	}
	constructor(private readonly scope: CacheScope) {}
	private get key() {
		return `${this.scope.namespace}:openings`;
	}
	private write(value: Opening[]) {
		if (!this.active) return;
		this.openings = value;
		try {
			if (browser) localStorage.setItem(this.key, JSON.stringify(value));
		} catch {
			/* Optional cache. */
		}
	}
	read(): readonly Opening[] {
		if (!browser || !this.active) return [];
		if (!this.openings) {
			let value: unknown;
			try {
				value = JSON.parse(localStorage.getItem(this.key) ?? 'null');
			} catch {
				/* Optional cache. */
			}
			this.openings = Array.isArray(value)
				? value
						.filter(
							(entry): entry is Opening =>
								!!entry && typeof entry.id === 'string' && Number.isFinite(entry.openedAt)
						)
						.sort((a, b) => b.openedAt - a.openedAt)
						.slice(0, 50)
				: [];
		}
		return this.openings;
	}
	record(id: string) {
		this.write(
			[{ id, openedAt: Date.now() }, ...this.read().filter((entry) => entry.id !== id)].slice(0, 50)
		);
	}
	forget(id: string) {
		this.write(this.read().filter((entry) => entry.id !== id));
	}
	/** Preparation order only; Home keeps the server's display order. */
	rank(cards: readonly SavedContractCard[], promoted: readonly string[] = []): string[] {
		const history = new Map(this.read().map((entry) => [entry.id, entry.openedAt]));
		return cards
			.map((card, order) => ({ card, order }))
			.sort(
				(a, b) =>
					Number(promoted.includes(b.card._id)) - Number(promoted.includes(a.card._id)) ||
					(history.get(b.card._id) ?? 0) - (history.get(a.card._id) ?? 0) ||
					b.card.savedAt - a.card.savedAt ||
					a.order - b.order
			)
			.map(({ card }) => card._id);
	}
}
