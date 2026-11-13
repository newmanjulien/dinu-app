import { subscribeNativePage } from '../native-pagination';
import type { ConvexClient } from 'convex/browser';
import type { Infer } from 'convex/values';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { DiscussionAccess } from './session.svelte';
import type { discussionMessage } from './validators';
import { LiveDiscussionPages } from './live-pages.svelte';
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
	readonly rows = $derived.by(() =>
		this.feed.authorized
			? [
					...new Map(
						[...this.own, ...this.feed.rows, ...this.tail].map((row) => [row.id, row])
					).values()
				].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
			: []
	);
	constructor(
		private client: ConvexClient,
		private access: DiscussionAccess,
		private threadId: Id<'discussionThreads'>
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
			() => this.reconcile()
		);
	}
	setActive(active: boolean) {
		if (this.active === active) return;
		this.active = active;
		this.generation++;
		this.releaseTail();
		for (const [id, stop] of this.created) {
			stop?.();
			this.created.set(id, undefined);
		}
		if (!active) {
			this.feed.stop();
			return;
		}
		this.feed.reset();
		this.reconcile();
	}
	retry() {
		if (!this.active) return;
		this.feed.retry();
		this.reconcile();
	}
	showCreated(id: Id<'discussionMessages'>) {
		if (!this.created.has(id)) this.created.set(id, undefined);
		while (this.created.size > 20) {
			const oldest = this.created.keys().next().value!;
			this.created.get(oldest)?.();
			this.created.delete(oldest);
			this.own = this.own.filter((row) => row.id !== oldest);
		}
		this.reconcile();
	}
	private releaseTail() {
		this.tailOwner = undefined;
		const stop = this.stopTail;
		this.stopTail = undefined;
		this.tail = [];
		stop?.();
	}
	private reconcile() {
		if (!this.active || !this.feed.authorized || !this.feed.firstPageAccepted || this.feed.done)
			this.releaseTail();
		else if (!this.tailOwner) {
			const owner = (this.tailOwner = Symbol('reply-tail'));
			const current = () => this.tailOwner === owner && this.active && this.feed.authorized;
			const stop = this.client.onUpdate(
				api.discussions.latestReplies,
				{ access: this.access, threadId: this.threadId },
				(rows) => {
					if (!current()) return;
					this.tail = rows;
					this.reconcile();
				},
				(error) => {
					if (current()) this.feed.refuse(error);
				}
			);
			if (current()) this.stopTail = stop;
			else stop();
		}
		if (!this.feed.authorized) {
			this.own = [];
		}
		const covered = new Set([...this.feed.rows, ...this.tail].map((row) => row.id));
		for (const [id, stop] of this.created) {
			if (!this.active || !this.feed.authorized || covered.has(id)) {
				stop?.();
				this.created.set(id, undefined);
				this.own = this.own.filter((row) => row.id !== id);
			} else if (!stop) {
				const generation = this.generation;
				let owned = true;
				const release = this.client.onUpdate(
					api.discussions.message,
					{ access: this.access, threadId: this.threadId, messageId: id },
					(row) => {
						if (!owned || !this.active || generation !== this.generation || !this.feed.authorized)
							return;
						this.own = [...this.own.filter((m) => m.id !== id), ...(row ? [row] : [])];
						if (!row) {
							this.created.get(id)?.();
							this.created.delete(id);
						}
					},
					(error) => {
						if (owned && this.active && generation === this.generation) this.feed.refuse(error);
					}
				);
				const stop = () => {
					owned = false;
					release();
				};
				if (this.created.has(id) && this.active && this.feed.authorized) this.created.set(id, stop);
				else stop();
			}
		}
	}
	destroy() {
		this.setActive(false);
		this.feed.destroy();
		this.created.clear();
		this.own = [];
		this.tail = [];
	}
}
