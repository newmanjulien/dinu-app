import type { NativePageSubscription } from '../native-pagination';
import { ReadAttempt } from '../auth/attempt';

const RETAINED_ROWS = 200;
const RETAINED_BYTES = 1024 * 1024;
const RETAINED_REPLY_FEEDS = 8;

/** Disposable display windows only: no cursor, observation or write authority is retained. */
export class DiscussionRetention {
	private windows = new Map<
		object,
		{ rows: unknown[]; bytes: number; reply: boolean; clear: () => void }
	>();
	remember<Row>(owner: object, rows: Row[], reply: boolean, clear: () => void) {
		const previous = this.windows.get(owner);
		if (previous?.rows === rows) {
			// Reopening the same retained window must not encode it again.
			this.windows.delete(owner);
			this.windows.set(owner, previous);
			return rows;
		}
		this.forget(owner);
		const retained: Row[] = [];
		const encoder = new TextEncoder();
		let bytes = 2;
		for (let i = rows.length - 1; i >= Math.max(0, rows.length - RETAINED_ROWS); i--) {
			const size = encoder.encode(JSON.stringify(rows[i])).byteLength + (retained.length ? 1 : 0);
			if (bytes + size > RETAINED_BYTES) break;
			bytes += size;
			retained.push(rows[i]);
		}
		if (retained.length || reply) this.windows.set(owner, { rows: retained, bytes, reply, clear });
		let total = 0,
			replies = 0;
		for (const window of this.windows.values()) {
			total += window.bytes;
			if (window.reply) replies++;
		}
		for (const [key, window] of this.windows) {
			if (total <= RETAINED_BYTES && replies <= RETAINED_REPLY_FEEDS) break;
			if (total <= RETAINED_BYTES && !window.reply) continue;
			this.windows.delete(key);
			total -= window.bytes;
			if (window.reply) replies--;
			window.clear();
		}
		return retained.reverse();
	}
	forget(owner: object) {
		this.windows.delete(owner);
	}
	clear() {
		for (const window of this.windows.values()) window.clear();
		this.windows.clear();
	}
}

/** The installed native pager owns split/end cursors and live page replacement. */
export class LiveDiscussionPages<Row extends { id: string }> {
	rows = $state.raw<Row[]>([]);
	currentRows = $state.raw<Row[]>([]);
	error = $state.raw<Error | null>(null);
	loading = $state(false);
	authorized = $state(true);
	done = $state(false);
	firstPageAccepted = $state(false);
	private subscription?: NativePageSubscription<Row>;
	private attempt?: ReadAttempt;
	private generation = 0;
	private active = false;
	private pending?: { baseline: number };
	private latestRequest?: { baseline: number };
	private retention: DiscussionRetention;
	constructor(
		private subscribe: (
			changed: () => void,
			fail: (error: Error) => void
		) => NativePageSubscription<Row>,
		private changed: () => void = () => {},
		private options: { retention?: DiscussionRetention; reply?: boolean; evicted?: () => void } = {}
	) {
		this.retention = options.retention ?? new DiscussionRetention();
	}
	/** Replace the subscription, retaining only a bounded provisional display. */
	reset() {
		this.stop();
		this.active = true;
		this.authorized = true;
		this.done = false;
		this.firstPageAccepted = false;
		this.error = null;
		this.loading = true;
		this.pending = this.latestRequest = { baseline: 0 };
		this.wait();
		const generation = this.generation;
		this.changed();
		const update = () => {
			if (!this.active || generation !== this.generation) return;
			const value = this.subscription?.getCurrentValue();
			if (!value) return;
			this.loading = value.status === 'LoadingFirstPage' || value.status === 'LoadingMore';
			this.done = value.status === 'Exhausted';
			if (value.status === 'LoadingFirstPage') {
				this.firstPageAccepted = false;
				this.currentRows = [];
				this.retainDisplay();
			} else {
				// A native replacement (including empty) owns its entire covered display.
				this.rows = this.currentRows = [
					...new Map(value.results.map((row) => [row.id, row])).values()
				];
				this.firstPageAccepted = true;
				this.retention.forget(this);
			}
			if (this.loading) this.wait();
			else {
				this.attempt?.complete();
				this.attempt = undefined;
			}
			this.changed();
			if (!this.active || generation !== this.generation) return;
			if (value.status !== 'CanLoadMore' && value.status !== 'Exhausted') return;
			const settled = this.pending;
			if (!settled) return;
			this.pending = undefined;
			// Effective filtering can leave a requested page empty without ending the feed.
			if (value.status === 'CanLoadMore' && value.results.length <= settled.baseline)
				queueMicrotask(() => {
					if (
						this.active &&
						generation === this.generation &&
						this.latestRequest === settled &&
						!this.pending
					)
						this.loadMore();
				});
		};
		try {
			const subscription = this.subscribe(update, (error) => {
				if (this.active && generation === this.generation) this.refuse(error);
			});
			if (this.active && generation === this.generation) this.subscription = subscription;
			else subscription.unsubscribe();
			update();
		} catch (error) {
			if (this.active && generation === this.generation)
				this.refuse(error instanceof Error ? error : new Error('Comments are unavailable.'));
		}
	}
	private wait() {
		if (this.attempt) return;
		const attempt = (this.attempt = new ReadAttempt(15_000));
		attempt.signal.addEventListener(
			'abort',
			() => {
				if (!this.active || this.attempt !== attempt) return;
				this.stop();
				this.error = new Error('Discussion request timed out. Try again.');
				this.changed();
			},
			{ once: true }
		);
	}
	loadMore() {
		if (
			!this.active ||
			!this.firstPageAccepted ||
			this.loading ||
			this.done ||
			!this.authorized ||
			this.error ||
			this.pending
		)
			return;
		const value = this.subscription?.getCurrentValue();
		if (!value || value.status !== 'CanLoadMore') return;
		const previous = this.latestRequest;
		const request = { baseline: value.results.length };
		this.pending = this.latestRequest = request;
		if (!value.loadMore(20)) {
			if (this.pending === request) this.pending = undefined;
			if (this.latestRequest === request) this.latestRequest = previous;
		}
	}
	refuse(error: Error) {
		this.release();
		this.retention.forget(this);
		this.rows = [];
		this.done = false;
		this.authorized = false;
		this.error = error;
		this.changed();
	}
	retry() {
		this.reset();
	}
	retainDisplay(rows = this.rows) {
		this.rows = this.retention.remember(this, rows, Boolean(this.options.reply), () => {
			this.rows = [];
			this.options.evicted?.();
		});
	}
	private release() {
		this.active = false;
		this.generation++;
		this.firstPageAccepted = false;
		this.currentRows = [];
		this.done = false;
		this.pending = this.latestRequest = undefined;
		this.subscription?.unsubscribe();
		this.subscription = undefined;
		const attempt = this.attempt;
		this.attempt = undefined;
		attempt?.abort();
		this.loading = false;
	}
	stop(rows = this.rows) {
		this.release();
		this.retainDisplay(rows);
	}
	destroy() {
		this.release();
		this.retention.forget(this);
		this.rows = [];
	}
}
