import { subscribeNativePage } from '../native-pagination';
import type { ConvexClient } from 'convex/browser';
import type { Infer } from 'convex/values';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { DiscussionAccess } from './session.svelte';
import type { discussionMessage } from './validators';
import { DiscussionRetention, LiveDiscussionPages } from './live-pages.svelte';
type Message = Infer<typeof discussionMessage>;
/** History, latest window and own successful writes have distinct visibility lifetimes. */
export class ReplyDiscussion {
	readonly feed: LiveDiscussionPages<Message>;
	private tail = $state.raw<Message[]>([]);
	private own = $state.raw<Message[]>([]);
	private created = new Map<Id<'discussionMessages'>, (() => void) | undefined>();
	private stopTail?: () => void;
	private tailOwner?: symbol;
	private generation = 0;
	private active = false;
	readonly rows = $derived.by(() => {
		if (!this.feed.authorized) return [];
		const rows = new Map<string, Message>();
		for (const row of [...this.own, ...this.feed.rows, ...this.tail]) {
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
			() => this.reconcile(),
			{ retention, reply: true, evicted: () => this.created.clear() }
		);
	}
	setActive(active: boolean) {
		if (this.active === active) return;
		this.active = active;
		this.generation++;
		if (!active) {
			// Collapse all readable windows before releasing their current observations.
			this.feed.stop(this.rows);
			this.releaseTail();
			this.releaseCreated();
			this.own = [];
			return;
		}
		this.feed.reset();
	}
	retry() {
		if (this.active) this.feed.retry();
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
		this.generation++;
		this.releaseTail();
		this.releaseCreated();
		this.feed.destroy();
		this.created.clear();
		this.own = [];
	}
}
