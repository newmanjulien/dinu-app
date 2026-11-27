import type { ConvexClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';
import { saveError } from '../contract/saved';
import type { DiscussionAccess, DiscussionList } from './validators';

/** One live contract snapshot; author identity and replies share its access fence. */
export class DiscussionReadState {
	private snapshot = $state.raw<DiscussionList>();
	authorized = $state(false);
	loading = $state(false);
	error = $state<string | null>(null);
	private active = false;
	private generation = 0;
	private release?: () => void;
	private timer?: ReturnType<typeof setTimeout>;
	private authorizedListeners = new Set<() => void>();
	private deauthorizedListeners = new Set<() => void>();

	constructor(
		readonly client: ConvexClient,
		readonly access: DiscussionAccess
	) {}

	get threads() {
		return this.authorized ? (this.snapshot?.threads ?? []) : [];
	}
	get viewer() {
		return this.authorized ? (this.snapshot?.viewer ?? null) : null;
	}
	get pendingFirstPage() {
		return this.loading && !this.authorized;
	}

	onAccess(authorized: () => void, deauthorized: () => void) {
		this.authorizedListeners.add(authorized);
		this.deauthorizedListeners.add(deauthorized);
		return () => {
			this.authorizedListeners.delete(authorized);
			this.deauthorizedListeners.delete(deauthorized);
		};
	}

	private stop() {
		this.generation++;
		clearTimeout(this.timer);
		this.release?.();
		this.release = undefined;
		this.snapshot = undefined;
		this.authorized = false;
		this.loading = false;
	}

	private start() {
		this.stop();
		const generation = this.generation;
		this.loading = true;
		this.error = null;
		const accept = (snapshot: DiscussionList) => {
			if (!this.active || generation !== this.generation) return;
			clearTimeout(this.timer);
			this.snapshot = snapshot;
			this.loading = false;
			this.error = null;
			this.authorized = true;
			for (const listener of this.authorizedListeners) listener();
		};
		const fail = (cause: unknown) => {
			if (!this.active || generation !== this.generation) return;
			clearTimeout(this.timer);
			this.snapshot = undefined;
			this.authorized = false;
			this.loading = false;
			this.error = saveError(cause, 'Comments are unavailable.');
			for (const listener of this.deauthorizedListeners) listener();
		};
		try {
			const subscription = this.client.onUpdate(
				api.discussions.list,
				{ access: this.access },
				accept,
				fail
			);
			this.release = subscription;
			const cached = subscription.getCurrentValue?.();
			if (cached !== undefined) accept(cached);
			if (this.loading)
				this.timer = setTimeout(
					() => fail(new Error('Comments are unavailable. Please try again.')),
					15_000
				);
		} catch (cause) {
			fail(cause);
		}
	}

	setActive(active: boolean) {
		if (this.active === active) return;
		this.active = active;
		if (active) this.start();
		else this.stop();
	}

	retry() {
		if (this.active && (this.error || !this.authorized)) this.start();
	}

	destroy() {
		this.active = false;
		this.stop();
		this.error = null;
		this.authorizedListeners.clear();
		this.deauthorizedListeners.clear();
	}
}
