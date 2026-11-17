import { subscribeNativePage } from '../native-pagination';
import type { ConvexClient } from 'convex/browser';
import type { Infer } from 'convex/values';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { DiscussionAccess } from './session.svelte';
import type { discussionMessage } from './validators';
import { DiscussionRetention, LiveDiscussionPages } from './live-pages.svelte';
type Message = Infer<typeof discussionMessage>;

/** Share a small number of in-flight page reads across every visible thread. */
export class ReplyLoadScheduler {
	private readonly limit = 4;
	private queued = new Map<ReplyDiscussion, () => boolean>();
	private running = new Set<ReplyDiscussion>();
	private scheduled = false;
	request(owner: ReplyDiscussion, run: () => boolean) {
		if (this.queued.has(owner) || this.running.has(owner)) return;
		this.queued.set(owner, run);
		this.schedule();
	}
	complete(owner: ReplyDiscussion) {
		if (!this.running.delete(owner)) return;
		this.schedule();
	}
	cancel(owner: ReplyDiscussion) {
		this.queued.delete(owner);
		this.complete(owner);
	}
	private schedule() {
		if (this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			while (this.running.size < this.limit && this.queued.size) {
				const [owner, run] = this.queued.entries().next().value!;
				this.queued.delete(owner);
				this.running.add(owner);
				try {
					if (!run()) this.complete(owner);
				} catch (error) {
					this.complete(owner);
					owner.feed.refuse(
						error instanceof Error ? error : new Error('Comments are unavailable.')
					);
				}
			}
		});
	}
}

/** History, latest window and own successful writes have distinct visibility lifetimes. */
export class ReplyDiscussion {
	readonly feed: LiveDiscussionPages<Message>;
	private tail = $state.raw<Message[]>([]);
	private own = $state.raw<Message[]>([]);
	private deleted = $state.raw(new Set<Id<'discussionMessages'>>());
	private created = new Map<Id<'discussionMessages'>, (() => void) | undefined>();
	private stopTail?: () => void;
	private tailOwner?: symbol;
	private generation = 0;
	private active = false;
	readonly rows = $derived.by(() => {
		if (!this.feed.authorized) return [];
		const rows = new Map<string, Message>();
		for (const row of [...this.own, ...this.feed.rows, ...this.tail]) {
			if (this.deleted.has(row.id)) continue;
			const previous = rows.get(row.id);
			if (
				!previous ||
				row.revision > previous.revision ||
				(row.revision === previous.revision && (!previous.deleted || row.deleted))
			)
				rows.set(row.id, row);
		}
		return [...rows.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	});
	constructor(
		private client: ConvexClient,
		private access: DiscussionAccess,
		private threadId: Id<'discussionThreads'>,
		private scheduler: ReplyLoadScheduler,
		retention = new DiscussionRetention()
	) {
		this.feed = new LiveDiscussionPages(
			(receive, fail) =>
				subscribeNativePage(
					client,
					api.discussions.replies,
					{ access, threadId },
					20,
					receive,
					fail
				),
			() => {
				this.reconcile();
				this.advanceLoading();
			},
			{ retention, reply: true, evicted: () => this.created.clear(), autoLoadEmptyPage: false }
		);
	}
	private advanceLoading() {
		if (!this.active) return;
		if (!this.feed.loading) this.scheduler.complete(this);
		if (
			this.feed.firstPageAccepted &&
			!this.feed.loading &&
			!this.feed.done &&
			!this.feed.error &&
			this.feed.authorized
		)
			this.scheduler.request(this, () => this.feed.loadMore());
	}
	setActive(active: boolean) {
		if (this.active === active) return;
		this.active = active;
		this.generation++;
		if (!active) {
			this.scheduler.cancel(this);
			// Collapse all readable windows before releasing their current observations.
			this.feed.stop(this.rows);
			this.releaseTail();
			this.releaseCreated();
			this.own = [];
			return;
		}
		this.scheduler.request(this, () => {
			this.feed.reset();
			return true;
		});
	}
	retry() {
		if (!this.active) return;
		this.scheduler.cancel(this);
		this.scheduler.request(this, () => {
			this.feed.retry();
			return true;
		});
	}
	showCreated(id: Id<'discussionMessages'>) {
		if (!this.created.has(id)) this.created.set(id, undefined);
		while (this.created.size > 20) {
			const oldest = this.created.keys().next().value!;
			this.created.get(oldest)?.();
			this.created.delete(oldest);
			this.own = this.own.filter((row) => row.id !== oldest);
		}
		if (!this.active) this.feed.retainDisplay();
		this.reconcile();
	}
	hideDeleted(id: Id<'discussionMessages'>) {
		this.created.get(id)?.();
		this.created.delete(id);
		this.own = this.own.filter((row) => row.id !== id);
		this.deleted = new Set([...this.deleted, id]);
	}
	private releaseCreated() {
		for (const [id, stop] of this.created) {
			stop?.();
			this.created.set(id, undefined);
		}
	}
	private releaseTail() {
		this.tailOwner = undefined;
		const stop = this.stopTail;
		this.stopTail = undefined;
		this.tail = [];
		stop?.();
	}
	private reconcile() {
		if (!this.feed.authorized) {
			this.generation++;
			this.releaseTail();
			this.releaseCreated();
			this.created.clear();
			this.own = [];
			return;
		}
		if (!this.active || !this.feed.firstPageAccepted) {
			if (this.tail.length || this.own.length) this.feed.retainDisplay(this.rows);
			this.releaseTail();
			this.releaseCreated();
			this.own = [];
			return;
		}
		if (this.feed.done) this.releaseTail();
		else if (!this.tailOwner) {
			const owner = (this.tailOwner = Symbol('reply-tail'));
			const current = () =>
				this.tailOwner === owner &&
				this.active &&
				this.feed.authorized &&
				this.feed.firstPageAccepted;
			try {
				const stop = this.client.onUpdate(
					api.discussions.latestReplies,
					{ access: this.access, threadId: this.threadId },
					(rows) => {
						if (!current()) return;
						// Replace the entire latest window; omissions cannot survive in it.
						this.tail = rows;
						this.reconcile();
					},
					(error) => {
						if (current()) this.feed.refuse(error);
					}
				);
				if (current()) this.stopTail = stop;
				else stop();
			} catch (error) {
				if (current())
					this.feed.refuse(error instanceof Error ? error : new Error('Comments are unavailable.'));
			}
		}
		if (!this.feed.authorized) return;
		const covered = new Set([...this.feed.currentRows, ...this.tail].map((row) => row.id));
		for (const [id, stop] of this.created) {
			if (covered.has(id)) {
				stop?.();
				this.created.set(id, undefined);
				this.own = this.own.filter((row) => row.id !== id);
			} else if (!stop) {
				const generation = this.generation;
				let owned = true;
				let release: (() => void) | undefined;
				const current = () =>
					owned &&
					this.active &&
					generation === this.generation &&
					this.feed.authorized &&
					this.feed.firstPageAccepted &&
					this.created.has(id);
				const stop = () => {
					owned = false;
					release?.();
					if (this.created.get(id) === stop) this.created.set(id, undefined);
				};
				this.created.set(id, stop);
				try {
					release = this.client.onUpdate(
						api.discussions.message,
						{ access: this.access, threadId: this.threadId, messageId: id },
						(row) => {
							if (!current()) return;
							this.own = [...this.own.filter((m) => m.id !== id), ...(row ? [row] : [])];
							if (!row) {
								stop();
								this.created.delete(id);
							}
						},
						(error) => {
							if (current()) this.feed.refuse(error);
						}
					);
					if (!owned) release();
				} catch (error) {
					const failed = current();
					stop();
					if (failed)
						this.feed.refuse(
							error instanceof Error ? error : new Error('Comments are unavailable.')
						);
				}
			}
		}
	}
	destroy() {
		this.active = false;
		this.scheduler.cancel(this);
		this.generation++;
		this.releaseTail();
		this.releaseCreated();
		this.feed.destroy();
		this.created.clear();
		this.own = [];
	}
}
