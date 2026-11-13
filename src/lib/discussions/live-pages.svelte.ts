import type { NativePageSubscription } from '../native-pagination';
import { ReadAttempt } from '../auth/attempt';
/** The installed native pager owns split/end cursors and live page replacement. */
export class LiveDiscussionPages<Row extends { id: string }> {
	rows = $state.raw<Row[]>([]);
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
	constructor(
		private subscribe: (
			changed: () => void,
			fail: (error: Error) => void
		) => NativePageSubscription<Row>,
		private changed: () => void = () => {}
	) {}
	reset() {
		this.stop();
		this.active = true;
		this.authorized = true;
		this.done = false;
		this.firstPageAccepted = false;
		this.error = null;
		this.rows = [];
		this.loading = true;
		this.pending = this.latestRequest = { baseline: 0 };
		this.wait();
		const generation = this.generation;
		const update = () => {
			if (!this.active || generation !== this.generation) return;
			const value = this.subscription?.getCurrentValue();
			if (!value) return;
			this.rows = [...new Map(value.results.map((row) => [row.id, row])).values()];
			this.loading = value.status === 'LoadingFirstPage' || value.status === 'LoadingMore';
			this.done = value.status === 'Exhausted';
			if (value.status !== 'LoadingFirstPage') this.firstPageAccepted = true;
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
		this.subscription = this.subscribe(update, (error) => {
			if (this.active && generation === this.generation) this.refuse(error);
		});
		update();
	}
	private wait() {
		if (this.attempt) return;
		const attempt = (this.attempt = new ReadAttempt(15_000));
		attempt.signal.addEventListener(
			'abort',
			() => {
				if (!this.active || this.attempt !== attempt) return;
				this.subscription?.unsubscribe();
				this.subscription = undefined;
				this.attempt = undefined;
				this.loading = false;
				this.error = new Error('Discussion request timed out. Try again.');
			},
			{ once: true }
		);
	}
	loadMore() {
		if (!this.active || this.loading || this.done || !this.authorized || this.error || this.pending)
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
		this.stop();
		this.rows = [];
		this.done = false;
		this.authorized = false;
		this.error = error;
		this.changed();
	}
	retry() {
		this.reset();
	}
	stop() {
		this.active = false;
		this.generation++;
		this.pending = this.latestRequest = undefined;
		this.subscription?.unsubscribe();
		this.subscription = undefined;
		const attempt = this.attempt;
		this.attempt = undefined;
		attempt?.abort();
		this.loading = false;
	}
	destroy() {
		this.stop();
		this.rows = [];
	}
}
