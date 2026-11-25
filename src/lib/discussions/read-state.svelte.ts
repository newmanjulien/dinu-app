import type { ConvexClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { saveError } from '../contract/saved';
import type { DiscussionAccess, DiscussionMessage, DiscussionThread } from './validators';

const PAGE_SIZE = 200;
const MAX_PAGES = 20;

type PageResult<Item> = {
	page: Item[];
	isDone: boolean;
	continueCursor: string;
	splitCursor?: string | null;
	pageStatus?: 'SplitRecommended' | 'SplitRequired' | null;
};

type PendingSplit<Item> = {
	left: PageWindow<Item>;
	right: PageWindow<Item>;
	leftResult?: PageResult<Item>;
	rightResult?: PageResult<Item>;
	required: boolean;
};

type PageWindow<Item> = {
	cursor: string | null;
	endCursor: string | null;
	items: Item[];
	error: string | null;
	stop: () => void;
	pendingSplit?: PendingSplit<Item>;
};

/** Reactive Convex pagination chain with pinned [cursor, endCursor] windows and SplitRequired handling. */
class PaginatedFeed<Item extends { id: string }> {
	private pages = $state.raw<Item[][]>([]);
	private windows: PageWindow<Item>[] = [];
	private generation = 0;
	authorized = $state(false);
	loading = $state(false);
	error = $state<string | null>(null);

	readonly rows = $derived.by(() => {
		if (!this.authorized) return [];
		const seen = new Set<string>();
		const merged: Item[] = [];
		for (const page of this.pages) {
			for (const item of page) {
				if (seen.has(item.id)) continue;
				seen.add(item.id);
				merged.push(item);
			}
		}
		return merged;
	});

	constructor(
		private subscribePage: (
			cursor: string | null,
			endCursor: string | null,
			onUpdate: (result: PageResult<Item>) => void,
			onError: (error: unknown) => void
		) => () => void,
		private fallbackError: string,
		private onAuthorized?: () => void,
		private onDeauthorized?: () => void
	) {}

	start() {
		this.stop();
		const generation = ++this.generation;
		this.loading = true;
		this.error = null;
		const first = this.createWindow(null, null, []);
		this.windows = [first];
		this.subscribeWindow(first, generation);
	}

	stop() {
		this.generation++;
		for (const win of this.windows) this.stopWindow(win);
		this.windows = [];
		this.pages = [];
		this.authorized = false;
		this.loading = false;
	}

	destroy() {
		this.stop();
		this.authorized = false;
		this.error = null;
	}

	private syncState() {
		this.pages = this.windows.map((win) => win.items);
		this.error = this.windows.find((win) => win.error)?.error ?? null;
	}

	private cancelPendingSplit(win: PageWindow<Item>) {
		if (!win.pendingSplit) return;
		const { left, right } = win.pendingSplit;
		win.pendingSplit = undefined;
		this.stopWindow(left);
		this.stopWindow(right);
	}

	private stopWindow(win: PageWindow<Item>) {
		this.cancelPendingSplit(win);
		win.stop();
	}

	private trimAfter(index: number) {
		while (this.windows.length > index + 1) {
			const removed = this.windows.pop();
			if (removed) this.stopWindow(removed);
		}
		this.syncState();
	}

	private createWindow(
		cursor: string | null,
		endCursor: string | null,
		items: Item[]
	): PageWindow<Item> {
		return { cursor, endCursor, items, error: null, stop: () => {} };
	}

	private beginSplit(
		parent: PageWindow<Item>,
		splitCursor: string,
		required: boolean,
		generation: number
	) {
		const left = this.createWindow(parent.cursor, splitCursor, []);
		const right = this.createWindow(splitCursor, parent.endCursor, []);
		parent.pendingSplit = { left, right, required };
		this.subscribeWindow(left, generation, parent);
		this.subscribeWindow(right, generation, parent);
	}

	private applyLiveResult(win: PageWindow<Item>, result: PageResult<Item>, generation: number) {
		const index = this.windows.indexOf(win);
		if (index < 0) return;
		if (result.pageStatus === 'SplitRequired' || result.pageStatus === 'SplitRecommended') {
			const required = result.pageStatus === 'SplitRequired';
			if (!result.splitCursor || this.windows.length >= MAX_PAGES) {
				if (required) {
					this.cancelPendingSplit(win);
					win.error = this.fallbackError;
					this.loading = false;
					this.syncState();
					return;
				}
			} else {
				if (!required) {
					win.items = result.page;
					win.error = null;
					this.loading = false;
					this.syncState();
					if (index === 0) {
						this.authorized = true;
						this.onAuthorized?.();
					}
				}
				if (!win.pendingSplit) {
					this.beginSplit(win, result.splitCursor, required, generation);
				} else if (required) {
					win.pendingSplit.required = true;
				}
				return;
			}
		}
		this.cancelPendingSplit(win);
		win.items = result.page;
		win.error = null;
		this.loading = false;
		this.syncState();
		if (index === 0) {
			this.authorized = true;
			this.onAuthorized?.();
		}
		const needsTail =
			index === this.windows.length - 1 &&
			this.windows.length < MAX_PAGES &&
			((win.endCursor === null && !result.isDone && Boolean(result.continueCursor)) ||
				win.endCursor !== null);
		if (!needsTail) return;
		const nextCursor = win.endCursor ?? result.continueCursor;
		if (!nextCursor) return;
		if (win.endCursor === null) {
			// Pin the completed page to [cursor, continueCursor] so live edits on earlier
			// pages never tear down or re-subscribe downstream windows.
			this.stopWindow(win);
			const pinned = this.createWindow(win.cursor, nextCursor, result.page);
			const next = this.createWindow(nextCursor, null, []);
			this.windows.splice(index, 1, pinned, next);
			this.syncState();
			this.subscribeWindow(pinned, generation);
			this.subscribeWindow(next, generation);
		} else {
			// Window was already pinned (e.g. page 0 recovered after trimming downstream pages).
			const next = this.createWindow(nextCursor, null, []);
			this.windows.push(next);
			this.syncState();
			this.subscribeWindow(next, generation);
		}
	}

	private subscribeWindow(
		win: PageWindow<Item>,
		generation: number,
		stagedParent?: PageWindow<Item>
	) {
		let stopped = false;
		let release: (() => void) | undefined;
		win.stop = () => {
			stopped = true;
			release?.();
		};
		const fail = (err: unknown) => {
			if (stopped || generation !== this.generation) return;
			const index = this.windows.indexOf(win);
			if (index >= 0) {
				this.cancelPendingSplit(win);
				win.error = saveError(err, this.fallbackError);
				this.loading = false;
				if (index === 0) {
					this.authorized = false;
					this.trimAfter(0);
					win.items = [];
					this.onDeauthorized?.();
				}
				this.syncState();
				return;
			}
			const split = stagedParent?.pendingSplit;
			if (!stagedParent || !split || (split.left !== win && split.right !== win)) return;
			this.cancelPendingSplit(stagedParent);
			if (split.required && this.windows.includes(stagedParent)) {
				stagedParent.error = saveError(err, this.fallbackError);
				this.loading = false;
				this.syncState();
			}
		};
		try {
			release = this.subscribePage(
				win.cursor,
				win.endCursor,
				(result) => {
					if (stopped || generation !== this.generation) return;
					if (this.windows.includes(win)) {
						this.applyLiveResult(win, result, generation);
						return;
					}
					const split = stagedParent?.pendingSplit;
					if (!stagedParent || !split || (split.left !== win && split.right !== win)) return;
					const parentIndex = this.windows.indexOf(stagedParent);
					if (parentIndex < 0) return;
					win.items = result.page;
					win.error = null;
					if (split.left === win) split.leftResult = result;
					else split.rightResult = result;
					if (!split.leftResult || !split.rightResult) return;
					if (this.windows.length >= MAX_PAGES) {
						const wasRequired = split.required;
						this.cancelPendingSplit(stagedParent);
						if (wasRequired) {
							stagedParent.error = this.fallbackError;
							this.loading = false;
							this.syncState();
						}
						return;
					}
					const { left, right, leftResult, rightResult } = split;
					stagedParent.pendingSplit = undefined;
					stagedParent.stop();
					this.windows.splice(parentIndex, 1, left, right);
					this.syncState();
					this.applyLiveResult(left, leftResult, generation);
					this.applyLiveResult(right, rightResult, generation);
				},
				fail
			);
			if (stopped) release();
		} catch (err) {
			fail(err);
		}
	}
}

export class ThreadReplies {
	private feed: PaginatedFeed<DiscussionMessage>;
	private active = false;

	constructor(
		client: ConvexClient,
		access: DiscussionAccess,
		readonly threadId: Id<'discussionThreads'>
	) {
		this.feed = new PaginatedFeed<DiscussionMessage>(
			(cursor, endCursor, onUpdate, onError) =>
				client.onUpdate(
					api.discussions.replies,
					{
						access,
						threadId,
						paginationOpts: {
							numItems: PAGE_SIZE,
							cursor,
							...(endCursor !== null ? { endCursor } : {})
						}
					},
					onUpdate,
					onError
				),
			'Replies are unavailable.'
		);
	}

	get rows() {
		return this.feed.rows;
	}
	get authorized() {
		return this.feed.authorized;
	}
	get loading() {
		return this.feed.loading;
	}
	get error() {
		return this.feed.error;
	}

	setActive(active: boolean) {
		if (this.active === active) return;
		this.active = active;
		if (active) this.feed.start();
		else this.feed.stop();
	}

	retry() {
		if (this.active) this.feed.start();
	}

	destroy() {
		this.active = false;
		this.feed.destroy();
	}
}

/** Buyer-link reads live independently of the current writer or presentation. */
export class DiscussionReadState {
	private threadFeed: PaginatedFeed<DiscussionThread>;
	private replyStreams = new Map<string, ThreadReplies>();
	private replyReferences = new Map<string, number>();
	private authorizedListeners = new Set<() => void>();
	private deauthorizedListeners = new Set<() => void>();
	private active = false;

	constructor(
		readonly client: ConvexClient,
		readonly access: DiscussionAccess
	) {
		this.threadFeed = new PaginatedFeed<DiscussionThread>(
			(cursor, endCursor, onUpdate, onError) =>
				client.onUpdate(
					api.discussions.list,
					{
						access,
						paginationOpts: {
							numItems: PAGE_SIZE,
							cursor,
							...(endCursor !== null ? { endCursor } : {})
						}
					},
					onUpdate,
					onError
				),
			'Comments are unavailable.',
			() => {
				for (const listener of this.authorizedListeners) listener();
			},
			() => {
				for (const stream of this.replyStreams.values()) stream.destroy();
				this.replyStreams.clear();
				this.replyReferences.clear();
				for (const listener of this.deauthorizedListeners) listener();
			}
		);
	}

	get threads() {
		return this.threadFeed.rows;
	}
	get authorized() {
		return this.threadFeed.authorized;
	}
	get loading() {
		return this.threadFeed.loading;
	}
	get pendingFirstPage() {
		return this.threadFeed.loading && !this.threadFeed.authorized;
	}
	get error() {
		return this.threadFeed.error;
	}

	onAccess(authorized: () => void, deauthorized: () => void) {
		this.authorizedListeners.add(authorized);
		this.deauthorizedListeners.add(deauthorized);
		return () => {
			this.authorizedListeners.delete(authorized);
			this.deauthorizedListeners.delete(deauthorized);
		};
	}

	acquireReplies(id: Id<'discussionThreads'>) {
		let state = this.replyStreams.get(id);
		if (!state) {
			state = new ThreadReplies(this.client, this.access, id);
			this.replyStreams.set(id, state);
		}
		this.replyStreams.delete(id);
		this.replyStreams.set(id, state);
		this.replyReferences.set(id, (this.replyReferences.get(id) ?? 0) + 1);
		this.trimReplies();
		return {
			state,
			release: () => {
				const remaining = (this.replyReferences.get(id) ?? 1) - 1;
				if (remaining > 0) this.replyReferences.set(id, remaining);
				else {
					this.replyReferences.delete(id);
					state.setActive(false);
				}
				this.trimReplies();
			}
		};
	}

	private trimReplies() {
		const detached = [...this.replyStreams.keys()].filter((id) => !this.replyReferences.has(id));
		for (const id of detached.slice(0, Math.max(0, detached.length - 8))) {
			this.replyStreams.get(id)?.destroy();
			this.replyStreams.delete(id);
		}
	}

	setActive(active: boolean) {
		if (this.active === active) return;
		this.active = active;
		if (active) this.threadFeed.start();
		else {
			this.threadFeed.stop();
			for (const stream of this.replyStreams.values()) stream.setActive(false);
		}
	}

	retry() {
		if (this.active && (this.threadFeed.error || !this.authorized)) this.threadFeed.start();
	}

	destroy() {
		this.active = false;
		this.threadFeed.destroy();
		for (const stream of this.replyStreams.values()) stream.destroy();
		this.replyStreams.clear();
		this.replyReferences.clear();
		this.authorizedListeners.clear();
		this.deauthorizedListeners.clear();
	}
}
